export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const ZERO_DECIMAL_CURRENCIES = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function currencyMinorDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new MoneyError("Currency must be an uppercase ISO code.");
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

function expandScientificNotation(input: string): string {
  const [coefficient, exponentText] = input.toLowerCase().split("e");
  if (!exponentText) return coefficient!;
  const exponent = Number(exponentText);
  const negative = coefficient!.startsWith("-");
  const unsigned = negative ? coefficient!.slice(1) : coefficient!;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = whole + fraction;
  const decimalPosition = whole.length + exponent;
  const expanded = decimalPosition <= 0
    ? `0.${"0".repeat(-decimalPosition)}${digits}`
    : decimalPosition >= digits.length
      ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
      : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return negative ? `-${expanded}` : expanded;
}

export function parseMajorToMinor(value: number | string, currency: string): number {
  const digits = currencyMinorDigits(currency);
  const text = expandScientificNotation(String(value));
  const match = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || (typeof value === "number" && !Number.isFinite(value))) {
    throw new MoneyError("Money amount must be a non-negative decimal.");
  }
  const fraction = match[2] ?? "";
  if (fraction.slice(digits).replaceAll("0", "") !== "") {
    throw new MoneyError("Money amount has more precision than its currency supports.");
  }
  const minor = BigInt(match[1]!) * (10n ** BigInt(digits)) +
    BigInt((fraction.slice(0, digits) + "0".repeat(digits)).slice(0, digits) || "0");
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("Money amount exceeds the supported range.");
  return Number(minor);
}

export function minorToMajor(minor: number, currency: string): number {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new MoneyError("Minor-unit amount must be a non-negative safe integer.");
  return minor / (10 ** currencyMinorDigits(currency));
}

export function formatMinorToMajorString(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new MoneyError("Minor-unit amount must be a non-negative safe integer.");
  const digits = currencyMinorDigits(currency);
  if (digits === 0) return String(minor);
  const scale = 10 ** digits;
  const whole = Math.floor(minor / scale);
  const fraction = String(minor % scale).padStart(digits, "0");
  return `${whole}.${fraction}`;
}

export function compareMinor(left: number, right: number): -1 | 0 | 1 {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) {
    throw new MoneyError("Money comparisons require non-negative safe integer minor units.");
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function calculateTotalMinor(unitPriceMinor: number, quantity: number): number {
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
    throw new MoneyError("Unit price must be non-negative integer minor units.");
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new MoneyError("Quantity must be a positive integer.");
  const total = BigInt(unitPriceMinor) * BigInt(quantity);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyError("Total exceeds the supported range.");
  return Number(total);
}

export function assertCurrencyMatch(expected: string, actual: string): void {
  if (expected !== actual) throw new MoneyError("Product currency does not match the configured policy currency.");
}
