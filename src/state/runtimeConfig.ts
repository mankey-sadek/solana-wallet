import * as fs from "fs";
import * as path from "path";
import { logger } from "../logger";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FILE_PATH = path.join(DATA_DIR, "runtime-config.json");

interface RuntimeConfigData {
  targetWallet?: string;
}

function load(): RuntimeConfigData {
  try {
    if (!fs.existsSync(FILE_PATH)) return {};
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    return raw.trim() ? (JSON.parse(raw) as RuntimeConfigData) : {};
  } catch (err) {
    logger.error("Failed to load runtime-config.json, ignoring overrides:", err);
    return {};
  }
}

class RuntimeConfigStore {
  private data: RuntimeConfigData = load();

  get(): RuntimeConfigData {
    return this.data;
  }

  set(patch: Partial<RuntimeConfigData>): void {
    this.data = { ...this.data, ...patch };
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE_PATH, JSON.stringify(this.data, null, 2), "utf8");
  }
}

export const runtimeConfig = new RuntimeConfigStore();
