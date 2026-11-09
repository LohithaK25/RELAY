import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AgentEventSchema,
  ProductSchema,
  PurchasePlanSchema,
  getAuditEventPresentation,
  getReceiptVerificationChecks,
  getTransactionReceiptState,
  MERCHANT_FULFILLMENT_DISCLOSURE,
  type TransactionReceiptState,
  type AgentEvent,
  type Product,
  type PurchasePlan,
  type ShoppingIntent
} from "@relay/shared";
import {
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  Command,
  LoaderCircle,
  Fingerprint,
  LockKeyhole,
  Orbit,
  Plus,
  RefreshCw,
  ShoppingBag,
  ShieldCheck,
  Sparkles,
  WalletCards
} from "lucide-react";

type HealthState = "checking" | "online" | "offline";
type IntentError = { code: string; message: string };
type CheckoutContext = {
  plan: PurchasePlan;
  product: Product;
  events: AgentEvent[];
  checkoutOutcome?: "cancelled";
};
const checkoutStorageKey = "relay.pending-paypal-checkout";

export default function App() {
  const [health, setHealth] = useState<HealthState>("checking");
  const [shoppingRequest, setShoppingRequest] = useState("");
  const [intent, setIntent] = useState<ShoppingIntent | null>(null);
  const [intentError, setIntentError] = useState<IntentError | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [productError, setProductError] = useState<IntentError | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [purchasePlan, setPurchasePlan] = useState<PurchasePlan | null>(null);
  const [purchaseProduct, setPurchaseProduct] = useState<Product | null>(null);
  const [purchaseEvents, setPurchaseEvents] = useState<AgentEvent[]>([]);
  const [serverPaymentEvents, setServerPaymentEvents] = useState<AgentEvent[]>([]);
  const [discoveryEvents, setDiscoveryEvents] = useState<AgentEvent[]>([]);
  const [purchaseError, setPurchaseError] = useState<IntentError | null>(null);
  const [creatingPlanFor, setCreatingPlanFor] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [isCreatingPayPalOrder, setIsCreatingPayPalOrder] = useState(false);
  const [isCapturingPayment, setIsCapturingPayment] = useState(false);
  const [captureOrderId, setCaptureOrderId] = useState<string | null>(null);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);
  const [serverConfirmedPlanId, setServerConfirmedPlanId] = useState<string | null>(null);
  const [checkoutCancelled, setCheckoutCancelled] = useState(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false);
  const requestFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const checkHealth = async () => {
      try {
        const response = await fetch("/api/health", { signal: controller.signal });
        if (!response.ok) throw new Error(`Health check failed: ${response.status}`);
        setHealth("online");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setHealth("offline");
      }
    };

    void checkHealth();
    const intervalId = window.setInterval(() => void checkHealth(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  async function refreshTransactionStatus(planId: string, context: CheckoutContext, wasCancelled: boolean) {
    setIsRefreshingStatus(true);
    try {
      const response = await fetch(`/api/agent/purchase-plan/${encodeURIComponent(planId)}/status`);
      const body = await response.json() as {
        success: boolean;
        plan?: PurchasePlan;
        product?: Product;
        events?: AgentEvent[];
        error?: IntentError;
      };
      const plan = PurchasePlanSchema.safeParse(body.plan);
      const product = ProductSchema.safeParse(body.product);
      const events = Array.isArray(body.events) ? body.events.map((event) => AgentEventSchema.safeParse(event)) : [];
      if (!response.ok || !body.success || !plan.success || !product.success ||
        !Array.isArray(body.events) || events.some((event) => !event.success)) {
        setPurchaseError(body.error ?? {
          code: "TRANSACTION_STATUS_UNAVAILABLE",
          message: "RELAY could not refresh this transaction from the server. Try again."
        });
        return;
      }

      const mergedEvents = mergeEvents(context.events, events.flatMap((event) => event.success ? [event.data] : []));
      const confirmedContext: CheckoutContext = {
        plan: plan.data,
        product: product.data,
        events: mergedEvents,
        ...(wasCancelled ? { checkoutOutcome: "cancelled" as const } : {})
      };
      setPurchasePlan(plan.data);
      setPurchaseProduct(product.data);
      setPurchaseEvents(mergedEvents);
      setServerPaymentEvents(events.flatMap((event) => event.success ? [event.data] : []));
      setCaptureOrderId(plan.data.paypalOrderId);
      setServerConfirmedPlanId(plan.data.planId);
      setCheckoutCancelled(wasCancelled && plan.data.status !== "COMPLETED");
      setPaymentMessage(plan.data.status === "COMPLETED"
        ? "PayPal payment captured and verified by RELAY."
        : plan.data.status === "FAILED"
          ? plan.data.paymentFailureReason ?? "PayPal payment could not be confirmed."
          : wasCancelled
            ? "Checkout was cancelled. No payment was completed."
            : "Payment has not been confirmed yet. Refresh status or retry verification.");
      setPurchaseError(null);
      sessionStorage.setItem(checkoutStorageKey, JSON.stringify(confirmedContext));
    } catch {
      setPurchaseError({
        code: "TRANSACTION_STATUS_UNAVAILABLE",
        message: "RELAY could not reach the transaction status service. Try again."
      });
    } finally {
      setIsRefreshingStatus(false);
    }
  }

  async function capturePayment(context: CheckoutContext, orderId: string) {
    setIsCapturingPayment(true);
    setCaptureOrderId(orderId);
    setPurchaseError(null);
    setPaymentMessage("Capturing payment and verifying the PayPal transaction…");
    try {
      const response = await fetch("/api/agent/paypal/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchasePlanId: context.plan.planId, paypalOrderId: orderId })
      });
      const body = await response.json() as {
        success: boolean;
        plan?: PurchasePlan;
        product?: Product;
        events?: AgentEvent[];
        error?: IntentError;
      };
      const plan = PurchasePlanSchema.safeParse(body.plan);
      const product = ProductSchema.safeParse(body.product);
      const responseEvents = Array.isArray(body.events) ? body.events.map((event) => AgentEventSchema.safeParse(event)) : [];
      if (plan.success && product.success &&
        (plan.data.status !== "COMPLETED" || response.ok && body.success)) {
        const authoritativeProduct = product.data;
        const events = mergeEvents(context.events, responseEvents.flatMap((event) => event.success ? [event.data] : []));
        const updatedContext: CheckoutContext = {
          plan: plan.data,
          product: authoritativeProduct,
          events
        };
        setPurchasePlan(plan.data);
        setPurchaseProduct(authoritativeProduct);
        setPurchaseEvents(events);
        setServerPaymentEvents(responseEvents.flatMap((event) => event.success ? [event.data] : []));
        setServerConfirmedPlanId(plan.data.planId);
        setCheckoutCancelled(false);
        sessionStorage.setItem(checkoutStorageKey, JSON.stringify(updatedContext));
        if (plan.data.status === "COMPLETED" && body.success) {
          setPaymentMessage("PayPal payment captured and verified by RELAY.");
          setPurchaseError(null);
        } else {
          setPaymentMessage(plan.data.paymentFailureReason ?? "Payment could not be confirmed by RELAY.");
          setPurchaseError(body.error ?? {
            code: "PAYPAL_CAPTURE_FAILED",
            message: "RELAY could not verify the payment. Check the transaction status before trying again."
          });
        }
      } else {
        setPurchaseError(body.error ?? {
          code: "PAYPAL_CAPTURE_FAILED",
          message: "RELAY could not verify the payment. Refresh transaction status before trying again."
        });
        setPaymentMessage("Payment status is not confirmed by RELAY.");
      }
    } catch {
      setPurchasePlan({ ...context.plan, status: "EXECUTING" });
      setPurchaseProduct(context.product);
      setPurchaseEvents(context.events);
      setPurchaseError({
        code: "PAYPAL_CAPTURE_UNAVAILABLE",
        message: "RELAY could not reach the verification service. Refresh transaction status before retrying."
      });
      setPaymentMessage("Payment status is not confirmed by RELAY.");
    } finally {
      setIsCapturingPayment(false);
    }
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    const returnState = url.searchParams.get("paypal");
    const planId = url.searchParams.get("planId");
    const orderId = url.searchParams.get("token");
    let context: CheckoutContext | null = null;
    try {
      const saved = sessionStorage.getItem(checkoutStorageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as { plan?: unknown; product?: unknown; events?: unknown; checkoutOutcome?: unknown };
        const plan = PurchasePlanSchema.safeParse(parsed.plan);
        const product = ProductSchema.safeParse(parsed.product);
        const events = Array.isArray(parsed.events) ? parsed.events.map((event) => AgentEventSchema.safeParse(event)) : [];
        if (plan.success && product.success && Array.isArray(parsed.events) && events.length === parsed.events.length && events.every((event) => event.success)) {
          context = {
            plan: plan.data,
            product: product.data,
            events: events.map((event) => event.data),
            ...(parsed.checkoutOutcome === "cancelled" ? { checkoutOutcome: "cancelled" } : {})
          };
        }
      }
    } catch {
      setPurchaseError({ code: "CHECKOUT_CONTEXT_UNAVAILABLE", message: "RELAY could not restore this checkout. Return to the product search and review the plan again." });
    }

    if (!returnState) {
      if (context) {
        setIsRefreshingStatus(true);
        void refreshTransactionStatus(
          context.plan.planId,
          context,
          context.checkoutOutcome === "cancelled"
        );
      }
      return;
    }

    if (!context || context.plan.planId !== planId || !context.product || !Array.isArray(context.events)) {
      setPurchaseError({ code: "CHECKOUT_CONTEXT_UNAVAILABLE", message: "RELAY could not verify the returned checkout context. No payment capture was requested." });
      return;
    }
    if (returnState === "cancel") {
      const cancellationEvent: AgentEvent = {
        id: crypto.randomUUID(),
        type: "PAYPAL_CHECKOUT_CANCELLED",
        message: "Buyer returned through PayPal's checkout cancellation URL; no capture was requested.",
        createdAt: new Date().toISOString()
      };
      const cancelledContext: CheckoutContext = {
        ...context,
        events: mergeEvents(context.events, [cancellationEvent]),
        checkoutOutcome: "cancelled"
      };
      setPurchasePlan({ ...context.plan, status: "EXECUTING" });
      setPurchaseProduct(context.product);
      setPurchaseEvents(cancelledContext.events);
      setServerPaymentEvents([]);
      setCheckoutCancelled(true);
      setPaymentMessage("Checkout was cancelled. No payment was completed.");
      sessionStorage.setItem(checkoutStorageKey, JSON.stringify(cancelledContext));
      url.searchParams.delete("paypal");
      url.searchParams.delete("planId");
      url.searchParams.delete("PayerID");
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url);
      void refreshTransactionStatus(context.plan.planId, cancelledContext, true);
      return;
    }
    if (returnState !== "success" || !orderId) {
      setPurchaseError({ code: "INVALID_PAYPAL_RETURN", message: "RELAY could not verify PayPal's return details." });
      return;
    }
    url.searchParams.delete("PayerID");
    url.searchParams.delete("paypal");
    url.searchParams.delete("planId");
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url);
    setPurchasePlan({ ...context.plan, status: "EXECUTING" });
    setPurchaseProduct(context.product);
    setPurchaseEvents(context.events);
    setCaptureOrderId(orderId);
    setServerConfirmedPlanId(null);
    setCheckoutCancelled(false);
    void capturePayment(context, orderId);
  }, []);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let intentWasParsed = false;
    setIntent(null);
    setIntentError(null);
    setProducts(null);
    setProductError(null);
    setPurchasePlan(null);
    setPurchaseProduct(null);
    setPurchaseEvents([]);
    setServerPaymentEvents([]);
    setServerConfirmedPlanId(null);
    setCheckoutCancelled(false);
    setCaptureOrderId(null);
    setDiscoveryEvents([]);
    sessionStorage.removeItem(checkoutStorageKey);
    setPurchaseError(null);
    setPaymentMessage(null);
    setCaptureOrderId(null);
    setIsSearching(false);
    setIsParsing(true);
    try {
      const response = await fetch("/api/agent/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: shoppingRequest })
      });
      const body = await response.json() as {
        success: boolean;
        intent?: ShoppingIntent;
        events?: AgentEvent[];
        error?: IntentError;
      };
      if (!response.ok || !body.success || !body.intent) {
        setIntentError(body.error ?? {
          code: "REQUEST_FAILED",
          message: "RELAY could not interpret that request. Please try again."
        });
        return;
      }
      setIntent(body.intent);
      setDiscoveryEvents(body.events ?? []);
      intentWasParsed = true;
      setIsParsing(false);
      setIsSearching(true);
      const productResponse = await fetch("/api/agent/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent: body.intent })
      });
      const productBody = await productResponse.json() as {
        success: boolean;
        products?: Product[];
        events?: AgentEvent[];
        error?: IntentError;
      };
      if (!productResponse.ok || !productBody.success || !productBody.products) {
        setProductError(productBody.error ?? {
          code: "PRODUCT_SEARCH_FAILED",
          message: "RELAY could not search commerce data. Please try again."
        });
        return;
      }
      setProducts(productBody.products);
      setDiscoveryEvents((events) => [...events, ...(productBody.events ?? [])]);
    } catch {
      if (intentWasParsed) {
        setProductError({
          code: "PRODUCT_SEARCH_UNAVAILABLE",
          message: "RELAY cannot reach product search. Check the API and try again."
        });
      } else {
        setIntentError({
          code: "API_UNAVAILABLE",
          message: "RELAY cannot reach the API. Start the server and try again."
        });
      }
    } finally {
      setIsParsing(false);
      setIsSearching(false);
    }
  }

  async function reviewPurchase(product: Product) {
    if (!intent) return;
    setCreatingPlanFor(product.id);
    setPurchaseError(null);
    setPurchasePlan(null);
    setPurchaseProduct(null);
    setServerPaymentEvents([]);
    try {
      const response = await fetch("/api/agent/purchase-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, quantity: intent.quantity, policy: {} })
      });
      const body = await response.json() as {
        success: boolean;
        plan?: PurchasePlan;
        product?: Product;
        events?: AgentEvent[];
        error?: IntentError;
      };
      if (!response.ok || !body.success || !body.plan || !body.product) {
        setPurchaseError(body.error ?? {
          code: "PURCHASE_PLAN_FAILED",
          message: "RELAY could not create a verified trust review. Please search again."
        });
        return;
      }
      setPurchasePlan(body.plan);
      setPurchaseProduct(body.product);
      setPurchaseEvents([...discoveryEvents, ...(body.events ?? [])]);
      setServerPaymentEvents([]);
      setServerConfirmedPlanId(body.plan.planId);
    } catch {
      setPurchaseError({
        code: "PURCHASE_PLAN_UNAVAILABLE",
        message: "RELAY cannot reach the trust service. Check the API and try again."
      });
    } finally {
      setCreatingPlanFor(null);
    }
  }

  async function approvePurchase() {
    if (!purchasePlan || purchasePlan.status !== "AWAITING_APPROVAL") return;
    setIsApproving(true);
    setPurchaseError(null);
    try {
      const response = await fetch(`/api/agent/purchase-plan/${purchasePlan.planId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const body = await response.json() as {
        success: boolean;
        plan?: PurchasePlan;
        events?: AgentEvent[];
        error?: IntentError;
      };
      if (!response.ok || !body.success || !body.plan) {
        setPurchaseError(body.error ?? {
          code: "APPROVAL_FAILED",
          message: "RELAY could not record approval for this plan."
        });
        return;
      }
      setPurchasePlan(body.plan);
      setServerConfirmedPlanId(body.plan.planId);
      const events = [...purchaseEvents, ...(body.events ?? [])];
      setPurchaseEvents(events);
      await createPayPalOrder(body.plan, events);
    } catch {
      setPurchaseError({
        code: "APPROVAL_UNAVAILABLE",
        message: "RELAY cannot reach the trust service. Check the API and try again."
      });
    } finally {
      setIsApproving(false);
    }
  }

  async function createPayPalOrder(plan: PurchasePlan, events: AgentEvent[]) {
    setIsCreatingPayPalOrder(true);
    setPurchaseError(null);
    setPaymentMessage("Creating secure PayPal Sandbox order…");
    try {
      const response = await fetch("/api/agent/paypal/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchasePlanId: plan.planId })
      });
      const body = await response.json() as {
        success: boolean;
        plan?: PurchasePlan;
        approvalUrl?: string;
        events?: AgentEvent[];
        error?: IntentError;
      };
      const nextEvents = [...events, ...(body.events ?? [])];
      if (body.events) setPurchaseEvents(nextEvents);
      if (!response.ok || !body.success || !body.plan || !body.approvalUrl) {
        setPurchaseError(body.error ?? { code: "PAYPAL_ORDER_FAILED", message: "RELAY could not create a PayPal Sandbox order." });
        setPaymentMessage("PayPal order could not be created.");
        return;
      }
      setPurchasePlan(body.plan);
      setPurchaseEvents(nextEvents);
      setServerConfirmedPlanId(body.plan.planId);
      setCheckoutCancelled(false);
      if (!purchaseProduct) {
        setPurchaseError({ code: "CHECKOUT_CONTEXT_UNAVAILABLE", message: "RELAY cannot preserve the verified product for PayPal return. Reopen the purchase review and try again." });
        setPaymentMessage("Checkout context could not be preserved.");
        return;
      }
      const context: CheckoutContext = { plan: body.plan, product: purchaseProduct, events: nextEvents };
      sessionStorage.setItem(checkoutStorageKey, JSON.stringify(context));
      window.location.assign(body.approvalUrl);
    } catch {
      setPurchaseError({
        code: "PAYPAL_ORDER_UNAVAILABLE",
        message: "RELAY cannot create or preserve the PayPal checkout context. Check the API and retry."
      });
      setPaymentMessage("PayPal order could not be created.");
    } finally {
      setIsCreatingPayPalOrder(false);
    }
  }

  async function retryCapture() {
    if (!purchasePlan || !captureOrderId) return;
    if (!purchaseProduct) return;
    await capturePayment({ plan: purchasePlan, product: purchaseProduct, events: purchaseEvents }, captureOrderId);
  }

  function startAnotherPurchase() {
    sessionStorage.removeItem(checkoutStorageKey);
    setShoppingRequest("");
    setIntent(null);
    setProducts(null);
    setPurchasePlan(null);
    setPurchaseProduct(null);
    setPurchaseEvents([]);
    setServerPaymentEvents([]);
    setPurchaseError(null);
    setPaymentMessage(null);
    setCaptureOrderId(null);
    setServerConfirmedPlanId(null);
    setCheckoutCancelled(false);
    requestFormRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function viewAuditTimeline() {
    document.getElementById("transaction-audit")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const healthLabel = {
    checking: "Connecting",
    online: "Systems operational",
    offline: "API unavailable"
  }[health];

  return (
    <main className="min-h-screen overflow-hidden bg-ink text-white">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="relative mx-auto flex min-h-screen max-w-[1440px] flex-col px-5 sm:px-8 lg:px-12">
        <header className="flex h-[84px] items-center justify-between border-b border-white/[0.07]">
          <a className="flex items-center gap-3" href="#" aria-label="RELAY home">
            <span className="brand-mark"><Orbit size={19} strokeWidth={1.8} /></span>
            <span className="font-display text-[17px] font-extrabold tracking-[0.19em]">RELAY</span>
            <span className="hidden rounded-full border border-white/[0.09] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/40 sm:inline-flex">Private beta</span>
          </a>
          <div className="flex items-center gap-5">
            <div className="hidden items-center gap-2 text-[11px] text-white/45 sm:flex">
              <span className={`status-dot ${health}`} />
              <span>{healthLabel}</span>
            </div>
            <button className="avatar" aria-label="Account profile">L</button>
          </div>
        </header>

        <section className="grid flex-1 items-center gap-12 pb-14 pt-12 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)] lg:gap-16 lg:py-16">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, ease: "easeOut" }}
            className="relative z-10"
          >
            <div className="mb-8 inline-flex items-center gap-2.5 rounded-full border border-mint/15 bg-mint/[0.06] px-3.5 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-mint">
              <Sparkles size={13} />
              Your commerce command center
            </div>
            <h1 className="font-display max-w-[760px] text-[clamp(3.35rem,7.2vw,6.6rem)] font-semibold leading-[0.99] tracking-[-0.075em]">
              Let your agent
              <br />
              <span className="headline-gradient">do the finding.</span>
              <br />
              You stay in control.
            </h1>
            <p className="mt-7 max-w-[530px] text-[15px] leading-7 text-white/48 sm:text-base">
              RELAY turns a simple request into a considered purchase plan. Nothing moves until you say so.
            </p>

            <form ref={requestFormRef} className="request-card mt-10 max-w-[680px]" onSubmit={submitRequest}>
              <div className="flex items-start gap-4">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-mint/15 bg-mint/[0.07] text-mint">
                  <Command size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center justify-between">
                    <label htmlFor="request" className="text-[11px] font-medium text-white/55">What are you looking for?</label>
                      <span className="font-mono text-[9px] tracking-wide text-white/25">USER REQUEST</span>
                  </div>
                  <textarea
                    id="request"
                      required
                      maxLength={2000}
                      rows={2}
                      value={shoppingRequest}
                      onChange={(event) => setShoppingRequest(event.target.value)}
                      placeholder="Tell RELAY what you want to buy..."
                      className="w-full resize-none bg-transparent text-[15px] leading-6 text-white outline-none placeholder:text-white/25"
                    />
                </div>
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-white/[0.07] pt-4">
                <div className="flex items-center gap-2 text-[10px] text-white/35">
                  <LockKeyhole size={12} />
                  Your approval is always required
                </div>
                <button className="launch-button" type="submit" disabled={isParsing || isSearching}>
                  {isParsing || isSearching ? <><LoaderCircle size={14} className="animate-spin" /><span>{isParsing ? "Understanding" : "Searching"}</span></> : <><span>Find products</span><ArrowUpRight size={15} /></>}
                </button>
              </div>
              <AnimatePresence>
                {isParsing && (
                  <motion.div
                    className="processing-line"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                  >
                    <span className="status-dot checking" />
                    RELAY is interpreting your request. No purchase will be made.
                  </motion.div>
                )}
              </AnimatePresence>
            </form>

            <AnimatePresence mode="wait">
              {intent && (
                <motion.section
                  key="intent"
                  className="intent-card mt-5 max-w-[680px]"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  aria-live="polite"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="event-badge"><Check size={11} /> INTENT_PARSED</span>
                      </div>
                      <h2 className="font-display text-lg font-semibold tracking-tight">Here’s what RELAY understood</h2>
                      <p className="mt-1 break-words text-xs leading-5 text-white/40">“{intent.originalRequest}”</p>
                    </div>
                    <span className="intent-check"><Check size={16} /></span>
                  </div>
                  <div className="intent-grid mt-5">
                    <IntentItem label="Product type" value={[intent.category, intent.productType].filter(Boolean).join(" / ") || "Not specified"} />
                    <IntentItem label="Budget" value={intent.budget ? `${new Intl.NumberFormat(undefined, { style: "currency", currency: intent.budget.currency, maximumFractionDigits: 0 }).format(intent.budget.amount)} maximum` : "Not specified"} />
                    <IntentItem label="Delivery" value={intent.deliveryRequirement ?? "No timing specified"} />
                    <IntentItem label="Quantity" value={String(intent.quantity)} />
                  </div>
                  <IntentList label="Required" values={intent.requiredAttributes} />
                  <IntentList label="Preferences" values={[...intent.preferredAttributes, ...intent.additionalPreferences]} />
                  <IntentList label="Excluded" values={intent.excludedAttributes} />
                  {(intent.location || intent.country) && (
                    <div className="mt-3 text-[10px] text-white/40">Location: {[intent.location, intent.country].filter(Boolean).join(", ")}</div>
                  )}
                  <div className="mt-4 border-t border-white/[0.07] pt-3 text-[10px] leading-5 text-white/35">
                    Interpretation only — any future purchase amount will be calculated and checked separately.
                  </div>
                </motion.section>
              )}
              {intentError && (
                <motion.div
                  key="error"
                  className={`intent-error mt-5 max-w-[680px] ${intentError.code === "AI_NOT_CONFIGURED" ? "config-error" : ""}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  role="alert"
                >
                  <div className="text-[11px] font-semibold text-white/85">
                    {intentError.code === "AI_NOT_CONFIGURED" ? "Gemini setup needed" : "Couldn’t understand that request"}
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-white/50">{intentError.message}</p>
                  {intentError.code !== "AI_NOT_CONFIGURED" && (
                    <button className="retry-button mt-3" type="button" onClick={() => requestFormRef.current?.requestSubmit()}>
                      Try again <ArrowUpRight size={12} />
                    </button>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {intent && (isSearching || products !== null || productError) && (
                <motion.section
                  key="products"
                  className="mt-7 max-w-[760px]"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  aria-live="polite"
                >
                  <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <div className="eyebrow">Real commerce data · deterministic evaluation</div>
                      <h2 className="mt-2 font-display text-xl font-semibold tracking-[-0.04em]">Products RELAY found for you</h2>
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.1em] text-white/35">
                      {isSearching
                        ? <><span className="status-dot checking" /> SEARCHING_COMMERCE</>
                        : products?.length
                          ? <><span className="status-dot online" /> PRODUCTS_FOUND</>
                          : products !== null ? "NO_MATCHES" : null}
                    </div>
                  </div>
                  <div className="mb-4 flex items-center gap-2 text-[10px] text-white/35">
                    <span className="event-badge"><Check size={11} /> INTENT_PARSED</span>
                    <ChevronRight size={12} />
                    <span className={`event-badge ${isSearching ? "event-badge-active" : "event-badge-muted"}`}>
                      {isSearching ? <LoaderCircle size={10} className="animate-spin" /> : <Check size={10} />} SEARCHING_COMMERCE
                    </span>
                    <ChevronRight size={12} />
                    <span className={`event-badge ${products?.length ? "" : "event-badge-muted"}`}>{products?.length === 0 ? "NO_MATCHES" : "PRODUCTS_FOUND"}</span>
                  </div>
                  {isSearching && (
                    <div className="searching-card"><LoaderCircle size={16} className="animate-spin text-mint" /> Searching Channel3 and applying your constraints…</div>
                  )}
                  {products?.length === 0 && (
                    <div className="empty-products">
                      <div className="empty-icon"><ShoppingBag size={18} /></div>
                      <div className="mt-3 text-sm font-semibold text-white/75">No matching products yet</div>
                      <p className="mt-1 text-[11px] leading-5 text-white/40">No discovered products met the requirements and compatible budget. Try adjusting your request.</p>
                    </div>
                  )}
                  {products && products.length > 0 && (
                    <>
                      <div className="mb-3 text-[10px] text-white/40">
                        {products.length} product{products.length === 1 ? "" : "s"} discovered by Channel3. RELAY applied deterministic budget and attribute checks.
                      </div>
                      <div className="space-y-3">
                        {products.map((product, index) => (
                          <ProductCard
                            key={`${product.id}-${index}`}
                            product={product}
                            index={index}
                            onReview={() => void reviewPurchase(product)}
                            disabled={creatingPlanFor !== null}
                          />
                        ))}
                      </div>
                    </>
                  )}
                  {productError && (
                    <div className={`intent-error ${productError.code === "COMMERCE_NOT_CONFIGURED" ? "config-error" : ""}`}>
                      <div className="text-[11px] font-semibold text-white/85">
                        {productError.code === "COMMERCE_NOT_CONFIGURED" ? "Channel3 setup needed" : "Product search unavailable"}
                      </div>
                      <p className="mt-1 text-[11px] leading-5 text-white/50">{productError.message}</p>
                      <button className="retry-button mt-3" type="button" onClick={() => requestFormRef.current?.requestSubmit()}>
                        Retry search <ArrowUpRight size={12} />
                      </button>
                    </div>
                  )}
                  {purchaseError && (
                    <div className={`intent-error mt-4 ${purchaseError.code === "PRODUCT_NOT_VERIFIED" ? "config-error" : ""}`} role="alert">
                      <div className="text-[11px] font-semibold text-white/85">
                        {purchaseError.code === "PAYPAL_NOT_CONFIGURED"
                          ? "PayPal Sandbox setup needed"
                          : purchaseError.code === "PURCHASE_QUANTITY_MISMATCH"
                            ? "Shopping request changed"
                            : "Trust or payment step unavailable"}
                      </div>
                      <p className="mt-1 text-[11px] leading-5 text-white/50">{purchaseError.message}</p>
                    </div>
                  )}
                </motion.section>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {purchasePlan && purchaseProduct && (
                <motion.div
                  className="mt-7 max-w-[760px]"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                >
                  <TrustReview
                    plan={purchasePlan}
                    product={purchaseProduct}
                    events={purchaseEvents}
                    serverEvents={serverPaymentEvents}
                    onApprove={() => void approvePurchase()}
                    onContinue={() => {
                      setCheckoutCancelled(false);
                      if (purchasePlan.status === "EXECUTING" && purchasePlan.paypalApprovalUrl) {
                        window.location.assign(purchasePlan.paypalApprovalUrl);
                      } else {
                        void createPayPalOrder(purchasePlan, purchaseEvents);
                      }
                    }}
                    onRetryCapture={() => void retryCapture()}
                    onRefreshStatus={() => void refreshTransactionStatus(
                      purchasePlan.planId,
                      { plan: purchasePlan, product: purchaseProduct, events: purchaseEvents },
                      checkoutCancelled
                    )}
                    onViewTimeline={viewAuditTimeline}
                    onStartAnother={startAnotherPurchase}
                    captureOrderId={captureOrderId}
                    isApproving={isApproving}
                    isCreatingPayPalOrder={isCreatingPayPalOrder}
                    isCapturingPayment={isCapturingPayment}
                    isRefreshingStatus={isRefreshingStatus}
                    paymentMessage={paymentMessage}
                    serverConfirmed={serverConfirmedPlanId === purchasePlan.planId}
                    checkoutCancelled={checkoutCancelled}
                    canRetryCapture={purchaseError?.code === "PAYPAL_CAPTURE_UNAVAILABLE"}
                  />
                </motion.div>
              )}
              {!intent && purchaseError && (
                <div className="intent-error mt-7 max-w-[760px]" role="alert">
                  <div className="text-[11px] font-semibold text-white/85">Transaction status unavailable</div>
                  <p className="mt-1 text-[11px] leading-5 text-white/50">{purchaseError.message}</p>
                  <button
                    className="retry-button mt-3"
                    type="button"
                    onClick={() => {
                      const saved = sessionStorage.getItem(checkoutStorageKey);
                      if (!saved) return;
                      try {
                        const context = JSON.parse(saved) as CheckoutContext;
                        void refreshTransactionStatus(context.plan.planId, context, context.checkoutOutcome === "cancelled");
                      } catch {
                        setPurchaseError({ code: "CHECKOUT_CONTEXT_UNAVAILABLE", message: "RELAY could not restore this transaction context." });
                      }
                    }}
                  >
                    Refresh transaction status <RefreshCw size={12} />
                  </button>
                </div>
              )}
            </AnimatePresence>
            {!intent && isRefreshingStatus && !purchasePlan && (
              <div className="searching-card mt-7 max-w-[760px]" role="status">
                <LoaderCircle size={16} className="animate-spin text-mint" />
                Refreshing the transaction status from RELAY…
              </div>
            )}

            <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 text-[10px] text-white/36">
              <span className="inline-flex items-center gap-2"><Check size={12} className="text-mint/75" /> AI understands, RELAY searches</span>
              <span className="inline-flex items-center gap-2"><Check size={12} className="text-mint/75" /> Policy checked before purchase</span>
              <span className="inline-flex items-center gap-2"><Check size={12} className="text-mint/75" /> Secure sandbox payments</span>
            </div>
          </motion.div>

          <motion.aside
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.16, ease: "easeOut" }}
            className="relative mx-auto w-full max-w-[430px] lg:ml-auto"
          >
            <div className="orbit-ring orbit-ring-outer" />
            <div className="orbit-ring orbit-ring-inner" />
            <div className="console-card relative z-10">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-mint/[0.09] text-mint"><Orbit size={15} /></div>
                  <span className="text-[11px] font-semibold tracking-wide text-white/80">RELAY agent</span>
                </div>
                <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">
                  <span className="status-dot idle" /> Standing by
                </div>
              </div>
              <div className="px-5 pb-5 pt-6">
                <div className="mb-6 flex items-end justify-between">
                  <div>
                    <div className="eyebrow">Transaction guardrails</div>
                    <div className="mt-2 font-display text-[20px] font-semibold tracking-[-0.04em]">Your rules. Always.</div>
                  </div>
                  <button className="icon-button" aria-label="Edit transaction guardrails"><Plus size={15} /></button>
                </div>
                <div className="space-y-2.5">
                  <Guardrail icon={<WalletCards size={15} />} label="Spending limit" value="Set per request" />
                  <Guardrail icon={<Fingerprint size={15} />} label="Purchase approval" value="Always required" active />
                  <Guardrail icon={<ShieldCheck size={15} />} label="Policy engine" value="Ready to evaluate" />
                </div>
                <div className="mt-5 rounded-xl border border-white/[0.07] bg-black/20 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="eyebrow">Decision trail</div>
                    <CircleHelp size={13} className="text-white/25" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.025] text-white/35">
                      <AudioLines size={14} />
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-white/65">{intent ? "INTENT_PARSED" : "Nothing to review yet"}</div>
                      <div className="mt-1 text-[10px] text-white/30">{intent ? "Constraints extracted. Ready for product discovery." : "Your agent’s decision trail will appear here."}</div>
                    </div>
                    <ChevronRight size={14} className="ml-auto text-white/20" />
                  </div>
                </div>
              </div>
            </div>
            <div className="relative z-10 mt-4 flex items-center justify-center gap-2 text-[10px] text-white/30">
              <span className="h-px w-8 bg-white/10" />
              AI proposes <span className="text-mint/55">·</span> Policy decides <span className="text-mint/55">·</span> You approve
              <span className="h-px w-8 bg-white/10" />
            </div>
          </motion.aside>
        </section>

        <footer className="flex flex-col gap-3 border-t border-white/[0.07] py-5 text-[10px] text-white/30 sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 RELAY. Trust the agent. Control the transaction.</span>
          <div className="flex items-center gap-2"><span className={`status-dot ${health}`} /> API {healthLabel.toLowerCase()}</div>
        </footer>
      </div>
    </main>
  );
}

function ProductCard({ product, index, onReview, disabled }: { product: Product; index: number; onReview: () => void; disabled: boolean }) {
  const relevantAttributes = Object.entries(product.attributes).slice(0, 3);
  return (
    <motion.article
      className="product-card"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06, duration: 0.32 }}
    >
      <div className="product-image">
        {product.imageUrl
          ? <img src={product.imageUrl} alt="" loading="lazy" />
          : <ShoppingBag size={20} className="text-white/20" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="source-badge"><span className="status-dot online" /> CHANNEL3</span>
          <span className={`availability ${product.availability}`}>
            {product.availability === "in_stock" ? "In stock" : product.availability === "out_of_stock" ? "Out of stock" : "Availability unknown"}
          </span>
        </div>
        <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-5 text-white/85">{product.title}</h3>
        {product.description && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-white/35">{product.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/40">
          <span>{product.merchant ?? "Merchant not provided"}</span>
          {product.category && <span className="text-white/20">·</span>}
          {product.category && <span>{product.category}</span>}
        </div>
        {relevantAttributes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {relevantAttributes.map(([key, value]) => <span className="attribute-chip" key={key}>{key}: {value}</span>)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-3 self-stretch">
        <div className="text-right">
          {product.price
            ? <div className="font-display text-sm font-bold text-mint">{new Intl.NumberFormat(undefined, { style: "currency", currency: product.price.currency, maximumFractionDigits: 2 }).format(product.price.amount)}</div>
            : <div className="text-xs text-white/35">Price unavailable</div>}
          {product.price && <div className="mt-1 text-[9px] text-white/30">{product.price.currency}</div>}
        </div>
        {product.productUrl && (
          <a className="product-link" href={product.productUrl} target="_blank" rel="noreferrer" aria-label={`View ${product.title} at ${product.merchant ?? "merchant"}`}>
            View offer <ArrowUpRight size={12} />
          </a>
        )}
        <button className="review-button" type="button" onClick={onReview} disabled={disabled}>
          {disabled ? "Reviewing…" : "Review purchase"}
        </button>
      </div>
    </motion.article>
  );
}

function TrustReview({
  plan,
  product,
  events,
  serverEvents,
  onApprove,
  onContinue,
  onRetryCapture,
  isApproving,
  isCreatingPayPalOrder,
  isCapturingPayment,
  isRefreshingStatus,
  paymentMessage,
  captureOrderId,
  canRetryCapture,
  serverConfirmed,
  checkoutCancelled,
  onRefreshStatus,
  onViewTimeline,
  onStartAnother
}: {
  plan: PurchasePlan;
  product: Product;
  events: AgentEvent[];
  serverEvents: AgentEvent[];
  onApprove: () => void;
  onContinue: () => void;
  onRetryCapture: () => void;
  isApproving: boolean;
  isCreatingPayPalOrder: boolean;
  isCapturingPayment: boolean;
  isRefreshingStatus: boolean;
  paymentMessage: string | null;
  captureOrderId: string | null;
  canRetryCapture: boolean;
  serverConfirmed: boolean;
  checkoutCancelled: boolean;
  onRefreshStatus: () => void;
  onViewTimeline: () => void;
  onStartAnother: () => void;
}) {
  const formatMoney = (amount: number, currency: string) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  const checkLabels: Record<string, string> = {
    PRODUCT_VERIFIED: "Verified product",
    TRANSACTION_LIMIT: "Transaction limit",
    ITEM_PRICE_LIMIT: "Item price",
    QUANTITY_LIMIT: "Quantity",
    CATEGORY_ALLOWLIST: "Category permission",
    CATEGORY_BLOCKLIST: "Category restriction",
    MERCHANT_ALLOWLIST: "Merchant permission",
    MERCHANT_BLOCKLIST: "Merchant restriction",
    APPROVAL_REQUIRED: "Approval required"
  };
  const approved = plan.status === "APPROVED";
  const rejected = plan.status === "POLICY_REJECTED";
  const completed = plan.status === "COMPLETED" && serverConfirmed;
  const failed = plan.status === "FAILED" && serverConfirmed;
  const receiptState = getTransactionReceiptState(plan, serverEvents, {
    serverConfirmed,
    checkoutCancelled
  });
  return (
    <motion.section
      className="trust-review mt-5"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] pb-4">
        <div>
          <div className="eyebrow">Deterministic policy · human approval</div>
          <h3 className="mt-2 font-display text-lg font-semibold">RELAY TRUST REVIEW</h3>
        </div>
        <span className={`plan-status ${approved ? "approved" : rejected ? "rejected" : plan.status === "EXECUTING" ? "executing" : completed ? "completed" : failed ? "failed" : ""}`}>{plan.status.replace(/_/g, " ")}</span>
      </div>
      {receiptState !== "hidden" && (
        <TransactionReceipt
          state={receiptState}
          plan={plan}
          product={product}
          serverEvents={serverEvents}
          serverConfirmed={serverConfirmed}
          isRefreshingStatus={isRefreshingStatus}
          onRefreshStatus={onRefreshStatus}
          onViewTimeline={onViewTimeline}
          onStartAnother={onStartAnother}
        />
      )}
      <div className="mt-4 flex items-center gap-3">
        <div className="product-image trust-image">
          {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <ShoppingBag size={18} className="text-white/20" />}
        </div>
        <div className="min-w-0">
          <div className="line-clamp-2 text-sm font-semibold text-white/80">{product.title}</div>
          <div className="mt-1 text-[10px] text-white/40">{plan.merchant}</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PlanAmount label="Unit price" value={formatMoney(plan.authoritativeUnitPrice.amount, plan.currency)} />
        <PlanAmount label="Quantity" value={String(plan.quantity)} />
        <PlanAmount label="Total" value={formatMoney(plan.authoritativeTotal.amount, plan.currency)} highlight />
        <PlanAmount label="Currency" value={plan.currency} />
      </div>
      <div className="mt-5">
        <div className="eyebrow mb-3">Policy checks · server evaluated</div>
        <ul className="space-y-2">
          {plan.policyDecision.checks.map((item) => (
            <li className="policy-check" key={item.name}>
              <span className={`policy-check-icon ${item.passed ? "passed" : "failed"}`}>{item.passed ? <Check size={12} /> : <CircleHelp size={12} />}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-semibold text-white/70">{checkLabels[item.name] ?? item.name}</span>
                <span className="mt-0.5 block text-[9px] leading-4 text-white/35">{item.message}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-4 rounded-xl border border-mint/10 bg-mint/[0.035] p-3 text-[10px] text-white/60">
        {paymentMessage
          ? <span className={`font-semibold ${failed ? "text-red-200" : completed ? "text-mint" : "text-white/75"}`}>{paymentMessage}</span>
          : completed
            ? <span className="font-semibold text-mint">Payment completed and verified by RELAY.</span>
            : failed
              ? <span className="font-semibold text-red-200">{plan.paymentFailureReason ?? "Payment could not be verified."}</span>
          : approved
          ? <span className="font-semibold text-mint">Approved by you. RELAY will create the PayPal Sandbox order using this verified total.</span>
          : rejected
            ? <span className="font-semibold text-red-200">Policy rejected this plan. No payment can be initiated.</span>
            : plan.status === "EXECUTING"
              ? <span><strong className="text-white/80">PayPal approval required.</strong> RELAY will capture only after PayPal returns you to this verified plan.</span>
              : <span><strong className="text-white/80">Approval required.</strong> RELAY will not initiate payment without your explicit approval.</span>}
      </div>
      {plan.status === "AWAITING_APPROVAL" && (
        <button className="approve-button mt-4 w-full" type="button" onClick={onApprove} disabled={isApproving}>
          {isApproving || isCreatingPayPalOrder
            ? <><LoaderCircle size={14} className="animate-spin" /> {isCreatingPayPalOrder ? "Creating secure PayPal order" : "Recording approval"}</>
            : <><Check size={14} /> Approve & continue to PayPal</>}
        </button>
      )}
      {(approved || plan.status === "EXECUTING") && (
        <button className="approve-button mt-4 w-full" type="button" onClick={onContinue} disabled={isCreatingPayPalOrder || isCapturingPayment}>
          {isCreatingPayPalOrder || isCapturingPayment
            ? <><LoaderCircle size={14} className="animate-spin" /> {isCapturingPayment ? "Verifying transaction" : "Creating secure PayPal order"}</>
            : <><WalletCards size={14} /> {plan.status === "EXECUTING" ? "Resume PayPal approval" : "Continue to PayPal Sandbox"}</>}
        </button>
      )}
      {captureOrderId && canRetryCapture && plan.status !== "COMPLETED" && plan.status !== "FAILED" && !isCapturingPayment && (
        <button className="retry-button mt-3 w-full justify-center" type="button" onClick={onRetryCapture}>
          Retry capture verification <ArrowUpRight size={12} />
        </button>
      )}
      <div className="mt-5 border-t border-white/[0.07] pt-4">
        <div className="eyebrow mb-3">Transaction audit · system events, not hidden reasoning</div>
        <div className="audit-boundary">
          <LockKeyhole size={13} />
          <span><strong>Human approval boundary.</strong> RELAY cannot create a PayPal order until you approve the verified plan.</span>
        </div>
        <ol id="transaction-audit" className="audit-timeline scroll-mt-8" aria-label="Transaction audit timeline">
          {events.map((event) => {
            const presentation = getAuditEventPresentation(event.type);
            return (
              <li className={`audit-event ${presentation.state}`} key={event.id}>
                <span className="audit-marker" aria-hidden="true" />
                <div className="audit-event-card">
                  <div className="audit-event-meta">
                    <span className="audit-event-type">{event.type.replace(/_/g, " ")}</span>
                    <span className="audit-event-source">{presentation.source}</span>
                    <time className="audit-event-time" dateTime={event.createdAt}>
                      {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.createdAt))}
                    </time>
                    <span className="audit-event-state">{presentation.state}</span>
                  </div>
                  <p className="audit-event-message">{event.message}</p>
                </div>
              </li>
            );
          })}
        </ol>
        {plan.paypalOrderId && (
          <div className="audit-order-reference">
            PayPal order <code>{plan.paypalOrderId}</code>
          </div>
        )}
      </div>
    </motion.section>
  );
}

function TransactionReceipt({
  state,
  plan,
  product,
  serverEvents,
  serverConfirmed,
  isRefreshingStatus,
  onRefreshStatus,
  onViewTimeline,
  onStartAnother
}: {
  state: TransactionReceiptState;
  plan: PurchasePlan;
  product: Product;
  serverEvents: AgentEvent[];
  serverConfirmed: boolean;
  isRefreshingStatus: boolean;
  onRefreshStatus: () => void;
  onViewTimeline: () => void;
  onStartAnother: () => void;
}) {
  const success = state === "success";
  const checks = getReceiptVerificationChecks(plan, serverEvents, serverConfirmed);
  const formatMoney = (amount: number, currency: string) =>
    new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  const completionEvent = serverEvents.find((event) => event.type === "PURCHASE_COMPLETED");
  const completedAt = plan.completedAt ?? completionEvent?.createdAt;
  const headline = success
    ? "Payment successful"
    : state === "cancelled"
      ? "Payment not completed"
      : state === "failed"
        ? "Payment could not be confirmed"
        : "Payment status pending";
  const explanation = success
    ? "PayPal confirmed the capture and RELAY verified the transaction against the approved plan."
    : state === "cancelled"
      ? "You cancelled the PayPal checkout. No capture was requested by RELAY."
      : state === "failed"
        ? plan.paymentFailureReason ?? "RELAY could not verify the PayPal payment. Review the audit timeline for the recorded failure."
        : !serverConfirmed
          ? "RELAY has not confirmed this payment status with the server yet. Refresh status before treating the payment as complete."
          : `The server reports ${plan.status.replace(/_/g, " ").toLowerCase()}. No successful payment is shown until verification completes.`;

  return (
    <section className={`transaction-receipt ${success ? "receipt-success" : state === "failed" ? "receipt-failed" : state === "cancelled" ? "receipt-cancelled" : "receipt-pending"}`} aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="receipt-icon" aria-hidden="true">
          {success ? <ShieldCheck size={21} /> : state === "failed" ? <CircleHelp size={20} /> : state === "cancelled" ? <CircleHelp size={20} /> : <LoaderCircle size={19} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="eyebrow">{success ? "Verified payment receipt" : state === "cancelled" ? "Checkout cancelled" : state === "failed" ? "Payment verification failed" : "Transaction status"}</div>
          <h4 className="mt-1 font-display text-xl font-semibold tracking-[-0.035em]">{headline}</h4>
          <p className="mt-1 text-[11px] leading-5 text-white/55">{explanation}</p>
        </div>
        <span className={`plan-status ${success ? "completed" : state === "failed" ? "failed" : ""}`}>
          {success ? "RELAY TRANSACTION COMPLETED" : plan.status.replace(/_/g, " ")}
        </span>
      </div>

      <div className="receipt-summary mt-5">
        <div className="min-w-0">
          <div className="eyebrow">Product</div>
          <div className="mt-1 text-sm font-semibold text-white/85">{product.title}</div>
          <div className="mt-1 text-[10px] text-white/45">{plan.merchant} · Channel3 offer</div>
        </div>
        <div className="receipt-total">
          <div className="eyebrow">{success ? "Captured total" : "Plan total"}</div>
          <div className="mt-1 font-display text-xl font-bold text-mint">{formatMoney(plan.authoritativeTotal.amount, plan.currency)}</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PlanAmount label="Quantity" value={String(plan.quantity)} />
        <PlanAmount label="Unit price" value={formatMoney(plan.authoritativeUnitPrice.amount, plan.currency)} />
        <PlanAmount label="Currency" value={plan.currency} />
        <PlanAmount label="Payment provider" value="PayPal Sandbox" />
      </div>

      <dl className="receipt-references mt-3">
        <div><dt>Transaction reference</dt><dd>{plan.planId}</dd></div>
        <div><dt>PayPal order ID</dt><dd>{plan.paypalOrderId ?? "Not available"}</dd></div>
        {success && <div><dt>PayPal capture ID</dt><dd>{plan.paypalCaptureId ?? "Not returned by PayPal"}</dd></div>}
        {success && <div><dt>Completed at</dt><dd>{completedAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(completedAt)) : "Timestamp unavailable"}</dd></div>}
      </dl>

      {success && (
        <>
          <ul className="receipt-verification mt-4" aria-label="Payment verification results">
            {checks.map((check) => (
              <li key={check.label} className={check.passed ? "passed" : "failed"}>
                <Check size={13} aria-hidden="true" />
                <span>{check.label}</span>
              </li>
            ))}
          </ul>
          <p className="receipt-disclosure mt-4">{MERCHANT_FULFILLMENT_DISCLOSURE}</p>
        </>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {state !== "pending" && (
          <button className="approve-button min-h-9 px-3" type="button" onClick={onStartAnother}>
            <Plus size={14} /> Start another purchase
          </button>
        )}
        <button className="retry-button" type="button" onClick={onViewTimeline}>
          View audit timeline <ArrowUpRight size={12} />
        </button>
        {state !== "success" && (
          <button className="retry-button" type="button" onClick={onRefreshStatus} disabled={isRefreshingStatus}>
            {isRefreshingStatus ? <LoaderCircle size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh status
          </button>
        )}
      </div>
    </section>
  );
}

function PlanAmount({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="plan-amount">
      <div className="eyebrow">{label}</div>
      <div className={`mt-1.5 truncate text-xs font-semibold ${highlight ? "text-mint" : "text-white/75"}`}>{value}</div>
    </div>
  );
}

function mergeEvents(...groups: AgentEvent[][]): AgentEvent[] {
  const events = new Map<string, AgentEvent>();
  for (const event of groups.flat()) events.set(event.id, event);
  return [...events.values()];
}

function IntentItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="intent-item">
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 truncate text-xs font-medium text-white/75">{value}</div>
    </div>
  );
}

function IntentList({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-2 text-[10px] text-white/38">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value, index) => <span className="attribute-chip" key={`${label}-${index}`}>{value}</span>)}
      </div>
    </div>
  );
}

function Guardrail({ icon, label, value, active = false }: { icon: React.ReactNode; label: string; value: string; active?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.018] px-3.5 py-3">
      <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${active ? "bg-mint/[0.08] text-mint/80" : "bg-white/[0.04] text-white/40"}`}>{icon}</span>
      <span className="text-[11px] text-white/55">{label}</span>
      <span className="ml-auto text-[10px] text-white/35">{value}</span>
      {active && <span className="h-1.5 w-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(141,245,193,0.5)]" />}
    </div>
  );
}
