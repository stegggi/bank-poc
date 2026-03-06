import fs from "node:fs";

function envEscapePem(pem) {
  // Ensure exactly one trailing newline, then escape all newlines for .env
  const normalized = pem.replace(/\r\n/g, "\n").replace(/\n?$/, "\n");
  return normalized.replace(/\n/g, "\\n");
}

function printVar(varName, filePath) {
  const pem = fs.readFileSync(filePath, "utf8");
  console.log(`${varName}="${envEscapePem(pem)}"`);
}

printVar("BANK_A_RSA_PRIVATE_KEY_PEM", "demo-keys/bankA_private.pem");
printVar("BANK_B_RSA_PRIVATE_KEY_PEM", "demo-keys/bankB_private.pem");
printVar("NEXT_PUBLIC_BANK_A_RSA_PUBLIC_KEY_PEM", "demo-keys/bankA_public.pem");
printVar("NEXT_PUBLIC_BANK_B_RSA_PUBLIC_KEY_PEM", "demo-keys/bankB_public.pem");
