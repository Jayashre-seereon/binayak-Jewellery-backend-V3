const ones = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const tens = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

const convertTwoDigits = (num) => {
  if (num === 0) return "";
  if (num < 20) return ones[num];
  const ten = Math.floor(num / 10);
  const one = num % 10;
  return `${tens[ten]}${one > 0 ? " " + ones[one] : ""}`.trim();
};

const convertThreeDigits = (num) => {
  const hundred = Math.floor(num / 100);
  const remainder = num % 100;
  let str = "";
  if (hundred > 0) {
    str += `${ones[hundred]} Hundred`;
  }
  if (remainder > 0) {
    str += (str ? " and " : "") + convertTwoDigits(remainder);
  }
  return str.trim();
};

// Indian grouping (crore / lakh / thousand / hundred). The crore part recurses, so
// amounts of 100 crore and above read correctly ("One Hundred and Twenty Crore").
const convertIndian = (num) => {
  if (num <= 0) return "";
  const parts = [];
  const crore = Math.floor(num / 10000000);
  let remaining = num % 10000000;
  const lakh = Math.floor(remaining / 100000);
  remaining %= 100000;
  const thousand = Math.floor(remaining / 1000);
  remaining %= 1000;

  if (crore > 0) parts.push(`${convertIndian(crore)} Crore`);
  if (lakh > 0) parts.push(`${convertTwoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${convertTwoDigits(thousand)} Thousand`);
  if (remaining > 0) parts.push(convertThreeDigits(remaining));
  return parts.join(" ").trim();
};

export const numberToWordsIndian = (amount) => {
  const num = Math.round(Number(amount || 0) * 100) / 100;
  if (!Number.isFinite(num) || num <= 0) return "Zero Rupees Only.";

  const integerPart = Math.floor(num);
  const paisePart = Math.round((num - integerPart) * 100);

  let words = convertIndian(integerPart) || "Zero";
  words += " Rupees";

  if (paisePart > 0) {
    words += ` and ${convertTwoDigits(paisePart)} Paise`;
  }

  words += " Only.";
  return words;
};
