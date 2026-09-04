import * as fs from "fs";
import * as path from "path";
import { OpenPosition } from "../types";
import { logger } from "../logger";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const FILE_PATH = path.join(DATA_DIR, "positions.json");

type Store = Record<string, OpenPosition>; // keyed by tokenMint

function load(): Store {
  try {
    if (!fs.existsSync(FILE_PATH)) return {};
    const raw = fs.readFileSync(FILE_PATH, "utf8");
    return raw.trim() ? (JSON.parse(raw) as Store) : {};
  } catch (err) {
    logger.error("Failed to load positions.json, starting fresh:", err);
    return {};
  }
}

function save(store: Store): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export class PositionStore {
  private store: Store;

  constructor() {
    this.store = load();
  }

  get(tokenMint: string): OpenPosition | undefined {
    return this.store[tokenMint];
  }

  upsert(position: OpenPosition): void {
    this.store[position.tokenMint] = position;
    save(this.store);
  }

  remove(tokenMint: string): void {
    delete this.store[tokenMint];
    save(this.store);
  }

  all(): OpenPosition[] {
    return Object.values(this.store);
  }
}
