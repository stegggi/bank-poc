// use-cases/uc8-tempo/lib/externalLeg.ts
//
// UC8 · Task 3 / Step 7 — the external (off-rail) leg behind an interface, so a real FX +
// local-payout implementation can replace the v1 narration WITHOUT touching the agent UI.
//
// In v1 this is NARRATED: timed pending → converting → settled, never instant — so the gap
// between "left the rail" (internal, done) and "arrived at the local bank" (external, slow)
// is visible. A production IExternalLeg would call an FX/liquidity partner + local rails.

export type LegStatus = "idle" | "pending" | "converting" | "settled" | "cancelled" | "failed";

export type ExternalLegParams = {
  fromCcy: string;
  toCcy: string;
  amountFrom: number; // on-rail amount that left (e.g. CHF)
  amountTo: number; // local amount to credit (e.g. NGN)
  beneficiary: string;
};

export interface IExternalLeg {
  /** Begin the external conversion + local payout. */
  initiate(params: ExternalLegParams): void;
  /** Current status. */
  status(): LegStatus;
  /** Subscribe to status changes; returns an unsubscribe fn. */
  subscribe(cb: (status: LegStatus, note: string) => void): () => void;
  /** Cancel while in flight (pending/converting). A settled leg cannot be cancelled. */
  cancel(): { cancelled: boolean; reason: string };
}

/** v1 narrated implementation. Delays are tunable; defaults are deliberately non-instant. */
export class NarratedExternalLeg implements IExternalLeg {
  private _status: LegStatus = "idle";
  private _subs = new Set<(s: LegStatus, n: string) => void>();
  private _timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private convertDelayMs = 3500, private settleDelayMs = 4500) {}

  initiate(params: ExternalLegParams): void {
    if (this._status !== "idle") return;
    const fmt = (n: number) => n.toLocaleString("en-US");
    this._emit("pending", `${fmt(params.amountFrom)} ${params.fromCcy} left the rail — queued for FX at the ${params.toCcy} edge.`);
    this._timers.push(setTimeout(() => this._emit("converting", `Converting ${params.fromCcy}→${params.toCcy} at the local edge…`), this.convertDelayMs));
    this._timers.push(setTimeout(() => this._emit("settled", `Settled — ${fmt(params.amountTo)} ${params.toCcy} credited to ${params.beneficiary}.`), this.convertDelayMs + this.settleDelayMs));
  }

  status(): LegStatus {
    return this._status;
  }

  subscribe(cb: (status: LegStatus, note: string) => void): () => void {
    this._subs.add(cb);
    return () => { this._subs.delete(cb); };
  }

  cancel(): { cancelled: boolean; reason: string } {
    if (this._status === "pending" || this._status === "converting") {
      this._clearTimers();
      this._emit("cancelled", "External leg cancelled before settlement — no local credit made.");
      return { cancelled: true, reason: "cancelled before settlement" };
    }
    if (this._status === "settled") return { cancelled: false, reason: "already settled — an arrived payout cannot be cancelled" };
    return { cancelled: false, reason: "nothing in flight" };
  }

  private _emit(s: LegStatus, note: string): void {
    this._status = s;
    this._subs.forEach((cb) => cb(s, note));
  }
  private _clearTimers(): void {
    this._timers.forEach(clearTimeout);
    this._timers = [];
  }
}
