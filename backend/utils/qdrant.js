import { QdrantClient } from "@qdrant/js-client-rest";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.join(__dirname, "../.env"),
});

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

if (!QDRANT_URL) {
  throw new Error("QDRANT_URL is missing from backend/.env");
}

if (!QDRANT_API_KEY) {
  throw new Error("QDRANT_API_KEY is missing from backend/.env");
}

console.log("Qdrant URL:", QDRANT_URL);
console.log("Qdrant API key loaded:", Boolean(QDRANT_API_KEY));

export function createQdrantClient(options = {}) {
  return new QdrantClient({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
    checkCompatibility: false,
    ...options,
  });
}

export const qdrant = createQdrantClient();