#!/usr/bin/env node
// ============================================================================
// Mars Bot — standalone (Node.js) automation for Project Mars (Robinhood Chain).
//
// Two independent engines, run off-browser (laptop / AWS / any box). Because it
// is NOT a browser it has no CORS limits, so it can talk to the game's own API
// (/api/book, /api/plots, /api/words) exactly the way the game does.
//
//   ENGINE 1  farm    — keeps Hauler rigs planted on your empty plots and
//                       auto-collects every ready tray. Collect requires the
//                       game's reveal signatures, which the bot fetches from the
//                       auth-gated /api/words endpoint after a SIWE sign-in with
//                       YOUR key (same call the game makes — no operator key).
//
//   ENGINE 2  market  — keeps every stone you hold listed 1 wei under the best
//                       ask that isn't yours, re-pricing at most once per minute.
//                       Dust asks are skipped (depth filter) and it never lists
//                       below the best bid, so a troll ask can't make it dump.
//
// SAFETY: dry-run is ON by default (MARS_DRY=0 to go live). Every write is
// eth_call-simulated first; a revert is logged and the tx is NOT sent. Paid
// planting is capped by MARS_MAX_SPEND (default 0 = free credits only).
//
// Configure with env vars (see .env.example). Never hard-code your key.
// ============================================================================

import { ethers } from "ethers";

// ---------------------------------------------------------------- config -----
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const cfg = {
  rpc:        process.env.MARS_RPC    || "https://rpc.mainnet.chain.robinhood.com",
  pk:         process.env.MARS_PK,                                   // REQUIRED, 0x...
  api:       (process.env.MARS_API    || "https://project-mars.app").replace(/\/+$/, ""),
  dry:        process.env.MARS_DRY !== "0",                          // default: dry-run
  farm:       process.env.MARS_FARM   !== "0",                       // engine 1 on/off
  market:     process.env.MARS_MARKET !== "0",                       // engine 2 on/off
  // farm
  targetRigs: num(process.env.MARS_TARGET_RIGS, 100),               // keep this many rigs planted
  maxSpend:   num(process.env.MARS_MAX_SPEND, 0),                    // optional cap on paid DRILL/cycle (0 = no cap, spend all)
  drillReserve: num(process.env.MARS_DRILL_RESERVE, 0),             // keep this much DRILL unspent
  external:   process.env.MARS_EXTERNAL === "1",                     // spill onto others' open plots
  farmMs:     num(process.env.MARS_FARM_MS, 30000),                  // farm loop cadence
  collectChunk: num(process.env.MARS_COLLECT_CHUNK, 20),            // trays per collect tx
  // market
  marketMs:   Math.max(60000, num(process.env.MARS_MARKET_MS, 60000)), // rebalance >= 60s apart
  depthUnits: num(process.env.MARS_DEPTH, 10),                       // dedust: ask must reach this depth
  minLot:     num(process.env.MARS_MIN_LOT, 2),                      // ignore ask lots smaller than this (qty-1 dust)
  maxLots:    Math.max(1, num(process.env.MARS_MAX_LOTS, 3)),        // sell-side depth per stone, in lots of 99 (contract caps a lot at 99)
  relistPct:  num(process.env.MARS_RELIST_PCT, 0.10),               // relist for qty growth >= this frac
  floorDrill: num(process.env.MARS_FLOOR_DRILL, 0),                  // extra absolute price floor (DRILL/stone)
};
const CHAIN = 4663;
const HAULER = 2, HAULER_COST = 125;                                 // tier index + DRILL cost
const MAX_LOT = 99, LOTS_PER_LISTING = 5;                            // on-chain caps: <=99 units/lot, <=5 distinct stones/listing
const STONE_NAMES = ["Sand Rock","Rust","Basalt","Copper","Nickel","Silver","Gold","Platinum","Iridium","Mars Glass","Diamond","Core Blue"];

const A = {
  site:    "0x776480e8cC2ae5492EC7744928BC9eD15b9F0Da1",
  plots:   "0x1AcD1E34526bB65f363e81FC1273c479f50692CC",
  land:    "0x8878EA7fc881BFA0a6ECd7266125a664323e4278",
  ore:     "0xd9d674b04a72affe00e06385535eaac10b988fca",
  stones:  "0x063bdba5c8c29a57c6530f2668cfd040b1282118",
  treasury:"0x8C394DEAf48ec1bd11FA297707c96021207ed48E",
  market:  "0x68eA283B0ff2D26fc7DDD5b4C30661DC524DE2Bc",
  poolMgr: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
};
const S = {
  balanceOf:        "0x70a08231", freeRigsOf:      "0x3e338229", allowance:        "0xdd62ed3e",
  approve:          "0x095ea7b3", balanceOfBatch:  "0x4e1273f4", isApprovedForAll: "0xe985e9c5",
  setApprovalForAll:"0xa22cb465", deployManyCredits:"0x6dcb2774", siteOf:          "0x018163dc",
  isOpen:           "0x4d6861a6", collect:         "0xeeffeb45", list:             "0x00dd0cbb",
  cancelListing:    "0x40e58ee5",
};

// -------------------------------------------------------------- helpers ------
const AB = ethers.AbiCoder.defaultAbiCoder();
const enc  = (types, vals) => AB.encode(types, vals).slice(2);
const data = (sel, types, vals) => sel + enc(types, vals);
const ONE  = 10n ** 18n;
const toWei = (drill) => BigInt(Math.round(drill * 1e6)) * (ONE / 1000000n);
const fmtWei = (wei, d = 4) => (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: d });
const fmtN = (n) => Number(n).toLocaleString("en-US");
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a) => console.log(ts(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => (s || "").toLowerCase();

let provider, wallet, ME;

// eth_call read
const call = (to, d) => provider.call({ to, data: d });

// simulate then (unless dry-run) send + wait
async function tx(to, d, label, value = 0n) {
  try { await provider.call({ to, data: d, from: ME, value }); }
  catch (e) { throw new Error(`sim reverted (${label}): ${errStr(e)}`); }
  if (cfg.dry) { log(`  DRY  ${label}  [${to} ${d.slice(0, 10)}]`); return "0xDRYRUN"; }
  const sent = await wallet.sendTransaction({ to, data: d, value });
  log(`  sent ${label}  ${sent.hash}`);
  await sent.wait(1);
  return sent.hash;
}
function errStr(e) {
  const m = (e && (e.shortMessage || e.reason || e.message)) || String(e);
  const hex = (JSON.stringify(e?.info || e?.data || "") .match(/0x[0-9a-fA-F]{8,}/) || [])[0];
  return hex ? `${m} ${hex.slice(0, 10)}` : m;
}

// ------------------------------------------------------------- game API ------
let TOKEN = null;
async function api(path, { method = "GET", body, auth = false } = {}) {
  const res = await fetch(`${cfg.api}/api${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(auth && TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(j.error || `${method} ${path} -> ${res.status}`); err.status = res.status; throw err; }
  return j;
}
// SIWE sign-in with your own key -> bearer token (EIP-4361, personal_sign)
async function signIn() {
  const { nonce, issuedAt } = await api(`/nonce?address=${ME}`);
  const host = new URL(cfg.api).host, origin = new URL(cfg.api).origin;
  const msg = [
    `${host} wants you to sign in with your Ethereum account:`, ME, "",
    "Claim your handle on the Project Mars land registry.", "",
    `URI: ${origin}`, "Version: 1", `Chain ID: ${CHAIN}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`,
  ].join("\n");
  const signature = await wallet.signMessage(msg);
  const s = await api("/session", { method: "POST", body: { message: msg, signature } });
  TOKEN = s.token;
  log(`signed in as ${s.username ? "@" + s.username : ME.slice(0, 8)}`);
  return s;
}
async function fetchWords() {
  try { return (await api("/words", { auth: true })).words || []; }
  catch (e) { if (e.status === 401 || e.status === 403) { await signIn(); return (await api("/words", { auth: true })).words || []; } throw e; }
}

// ------------------------------------------------------------- on-chain ------
async function drillBalance() { return BigInt(await call(A.ore, data(S.balanceOf, ["address"], [ME]))); }
async function stoneBalances() {
  const ids = [...Array(12).keys()];
  const r = await call(A.stones, data(S.balanceOfBatch, ["address[]", "uint256[]"], [Array(12).fill(ME), ids]));
  return AB.decode(["uint256[]"], r)[0].map((x) => Number(x));
}
async function freeHaulerCredits() {
  const r = await call(A.site, data(S.freeRigsOf, ["address"], [ME]));
  const h = r.replace(/^0x/, ""), w = [];
  for (let i = 0; i < h.length; i += 64) w.push(h.slice(i, i + 64));
  const five = (w.length >= 7 && parseInt(w[0], 16) === 32 && parseInt(w[1], 16) === 5 ? w.slice(2, 7) : w.slice(0, 5)).map((x) => parseInt(x || "0", 16));
  return five[HAULER - 1] || 0;
}
async function activeRigCount() {
  const r = await call(A.site, data(S.siteOf, ["address"], [ME]));
  const h = r.replace(/^0x/, ""), W = (i) => h.slice(i * 64, i * 64 + 64);
  const off = parseInt(W(0), 16) / 32;
  return parseInt(W(off), 16) || 0;   // length of the rig-rows array
}
async function isOpenPlot(id) {
  try { return BigInt(await call(A.plots, data(S.isOpen, ["uint256"], [id]))) === 1n; } catch { return false; }
}
async function ensureAllowance(spender, needWei, label) {
  const cur = BigInt(await call(A.ore, data(S.allowance, ["address", "address"], [ME, spender])));
  if (cur >= needWei) return;
  await tx(A.ore, data(S.approve, ["address", "uint256"], [spender, needWei * 4n]), `approve ${label}`);
}
async function ensureStoneApproval() {
  const ok = BigInt(await call(A.stones, data(S.isApprovedForAll, ["address", "address"], [ME, A.market]))) === 1n;
  if (!ok) await tx(A.stones, data(S.setApprovalForAll, ["address", "bool"], [A.market, true]), "approve market (stones)");
}

// ============================================================ ENGINE 1 =======
// collect every ready tray, then top the rig count back up with haulers.
async function engineFarm() {
  await collectReady();
  await plantHaulers();
}

async function collectReady() {
  let words;
  try { words = await fetchWords(); }
  catch (e) { log(`collect: signer step failed — ${errStr(e)}`); return; }
  if (!words.length) return;
  const items = words.map((w) => ({
    nonce: BigInt(w.nonce),
    blockHash: w.blockHash.startsWith("0x") ? w.blockHash : "0x" + w.blockHash,
    signature: w.signature.startsWith("0x") ? w.signature : "0x" + w.signature,
  }));
  log(`collect: ${items.length} ready tray(s)`);
  for (let i = 0; i < items.length; i += cfg.collectChunk) await collectBatch(items.slice(i, i + cfg.collectChunk));
}
// send one collect; if it reverts, bisect so one bad tray can't block the rest
async function collectBatch(items) {
  if (!items.length) return;
  const d = data(S.collect, ["uint256[]", "bytes32[]", "bytes[]"], [items.map((x) => x.nonce), items.map((x) => x.blockHash), items.map((x) => x.signature)]);
  try { await tx(A.site, d, `collect ${items.length}`); log(`  collected ${items.length} tray(s)`); }
  catch (e) {
    if (items.length === 1) { log(`  skip tray nonce ${items[0].nonce}: ${errStr(e)}`); return; }
    const mid = items.length >> 1;
    await collectBatch(items.slice(0, mid));
    await collectBatch(items.slice(mid));
  }
}

async function plantHaulers() {
  const active = await activeRigCount();
  const capLeft = Math.max(0, 100 - active);
  let want = Math.min(cfg.targetRigs - active, capLeft);
  if (want <= 0) return;

  const plots = (await api("/plots")).plots || [];
  let empties = plots.filter((p) => lc(p.owner) === lc(ME) && !p.rig && !p.burned)
    .map((p) => ({ id: p.parcel, level: p.level })).sort((a, b) => b.level - a.level || a.id - b.id);
  if (cfg.external && empties.length < want) {
    const cand = plots.filter((p) => lc(p.owner) !== lc(ME) && !p.rig && !p.burned)
      .sort((a, b) => b.level - a.level || a.parcel - b.parcel).slice(0, (want - empties.length) * 4);
    for (const p of cand) { if (empties.length >= want) break; if (await isOpenPlot(p.parcel)) empties.push({ id: p.parcel, level: p.level }); }
  }
  want = Math.min(want, empties.length);
  if (want <= 0) { log("plant: no empty plots available"); return; }

  const free = await freeHaulerCredits();
  let paid = Math.max(0, want - free);
  if (paid > 0) {
    // fund paid haulers from the DRILL in your wallet, down to the reserve; MARS_MAX_SPEND is an optional per-cycle cap
    const bal = await drillBalance();
    const reserveWei = toWei(cfg.drillReserve);
    const spendable = bal > reserveWei ? bal - reserveWei : 0n;
    let affordable = Number(spendable / (BigInt(HAULER_COST) * ONE));
    if (cfg.maxSpend > 0) affordable = Math.min(affordable, Math.floor(cfg.maxSpend / HAULER_COST));
    paid = Math.min(paid, affordable);
    want = free + paid;
    if (want <= 0) { log(`plant: ${empties.length} empty, ${free} free, DRILL ${fmtWei(bal, 0)} funds 0 haulers (${HAULER_COST} ea${cfg.drillReserve ? `, reserve ${cfg.drillReserve}` : ""}${cfg.maxSpend ? `, cap ${cfg.maxSpend}/cycle` : ""})`); return; }
  }

  const maxWei = BigInt(paid * HAULER_COST) * ONE;
  if (paid > 0) await ensureAllowance(A.site, maxWei, "site (DRILL)");
  // contract requires ascending parcel order; pick best (highest-level) plots then sort ascending
  const parcels = empties.slice(0, want).map((p) => p.id).sort((a, b) => a - b);
  const tiers = parcels.map(() => HAULER);
  log(`plant: ${want}× Hauler (${free ? Math.min(free, want) + " free" : ""}${paid ? (free ? " + " : "") + paid + " paid=" + paid * HAULER_COST + " DRILL" : ""}) on ${lvHist(empties.slice(0, want).map((p) => p.level))} — rigs ${active}->${active + want}/100`);
  await tx(A.site, data(S.deployManyCredits, ["uint256[]", "uint256[]", "uint256"], [parcels, tiers, maxWei]), `deploy ${want} haulers`);
}
const lvHist = (ls) => { const m = {}; ls.forEach((l) => (m[l] = (m[l] || 0) + 1)); return Object.keys(m).map(Number).sort((a, b) => b - a).map((k) => "L" + k + (m[k] > 1 ? "×" + m[k] : "")).join(" · "); };

// ============================================================ ENGINE 2 =======
// keep every held stone listed 1 wei under the best ask that isn't mine.
let lastRebalance = 0;
async function engineMarket() {
  if (Date.now() - lastRebalance < cfg.marketMs) return;   // hard cap: 1 rebalance / minute
  const book = await api("/book");
  const listings = book.listings || [], offers = book.offers || [];
  const mine = (a) => lc(a) === lc(ME);

  // best OTHER ask per stone. Two dedust layers so thin liquidity can't drag the price:
  //   (1) skip any lot smaller than minLot units (kills qty-1 pollution outright)
  //   (2) of what's left, take the price only once cumulative depth reaches depthUnits
  const ladder = Array.from({ length: 12 }, () => []);
  for (const L of listings) if (!mine(L.seller)) for (const lot of L.lots || []) if (lot.amount >= cfg.minLot && lot.id < 12) ladder[lot.id].push({ p: BigInt(lot.price), a: lot.amount });
  const bestOther = Array(12).fill(0n);
  for (let i = 0; i < 12; i++) { const arr = ladder[i].sort((x, y) => (x.p < y.p ? -1 : x.p > y.p ? 1 : 0)); let cum = 0; for (const x of arr) { cum += x.a; bestOther[i] = x.p; if (cum >= cfg.depthUnits) break; } }
  // best bid per stone — a floor we never list below (a troll can't force a dump)
  const bestBid = Array(12).fill(0n);
  for (const o of offers) if (o.ore < 12) { const p = BigInt(o.price); if (p > bestBid[o.ore]) bestBid[o.ore] = p; }
  const floorAbs = toWei(cfg.floorDrill);

  // my current listings, aggregated per stone
  const myIds = [], myLots = Array.from({ length: 12 }, () => ({ qty: 0, price: null }));
  for (const L of listings) if (mine(L.seller)) { myIds.push(L.id); for (const lot of L.lots || []) if (lot.id < 12) { myLots[lot.id].qty += lot.amount; const p = BigInt(lot.price); myLots[lot.id].price = myLots[lot.id].price === null ? p : (p < myLots[lot.id].price ? p : myLots[lot.id].price); } }

  const wallet = await stoneBalances();

  // desired sell-side depth per stone = min(held+listed, maxLots*99) at (bestOther-1), floored.
  // capped so the maker keeps a competitive depth and replenishes as it sells, instead of dumping
  // thousands of units across dozens of txs (the contract caps a lot at 99 and forbids duplicate ids).
  const CAPUNITS = cfg.maxLots * 99;
  const targets = [];
  for (let i = 0; i < 12; i++) {
    if (bestOther[i] === 0n) continue;                         // nobody else selling -> nothing to undercut
    const total = wallet[i] + myLots[i].qty;
    if (total <= 0) continue;
    let t = bestOther[i] - 1n;
    const floor = bestBid[i] > floorAbs ? bestBid[i] : floorAbs;
    if (t < floor) t = floor;                                  // never below best bid / configured floor
    if (t <= 0n) continue;
    targets.push({ stone: i, price: t, qty: Math.min(total, CAPUNITS) });   // qty = depth to keep listed
  }

  // rebalance only when something actually drifted (this also throttles churn)
  const desired = new Set(targets.map((t) => t.stone));
  const reasons = [];
  for (const t of targets) {
    const cur = myLots[t.stone];
    if (cur.price === null) { reasons.push(`list ${STONE_NAMES[t.stone]}×${t.qty}`); continue; }
    if (cur.price !== t.price) { reasons.push(`reprice ${STONE_NAMES[t.stone]} ${fmtWei(cur.price)}→${fmtWei(t.price)}`); continue; }
    const gap = t.qty - cur.qty;                                // depth sold off that the wallet can top back up
    if (gap >= Math.max(1, Math.floor(t.qty * cfg.relistPct)) && wallet[t.stone] > 0) reasons.push(`refill ${STONE_NAMES[t.stone]} ${cur.qty}→${t.qty}`);
  }
  for (let i = 0; i < 12; i++) if (myLots[i].price !== null && !desired.has(i)) reasons.push(`delist ${STONE_NAMES[i]}`);
  if (!reasons.length) return;

  log(`market: rebalance — ${reasons.slice(0, 6).join(", ")}${reasons.length > 6 ? " …" : ""}`);
  lastRebalance = Date.now();

  // cancel all my listings (returns escrow to the wallet), then re-list at fresh targets
  for (const id of myIds) { try { await tx(A.market, data(S.cancelListing, ["uint256"], [id]), `cancel #${id}`); } catch (e) { log(`  cancel #${id} failed: ${errStr(e)}`); } }

  await ensureStoneApproval();
  const fresh = cfg.dry ? wallet.map((w, i) => w + myLots[i].qty) : await stoneBalances();   // after cancel, escrow is back in wallet
  // split each stone into <=99 lots; a stone id may appear only once per listing, so bin-pack:
  // listing tranche i holds lot i of every stone that still has one -> unique ids, <=99 each, <=maxLots tranches.
  const perStone = targets.map((t) => {
    let rem = Math.min(fresh[t.stone], t.qty); const lots = [];
    while (rem > 0) { const a = Math.min(MAX_LOT, rem); lots.push({ stone: t.stone, amount: a, price: t.price }); rem -= a; }
    return lots;
  }).filter((c) => c.length);
  const K = perStone.reduce((m, c) => Math.max(m, c.length), 0);
  if (!K) { log("  nothing to list after cancel"); return; }
  // one lot of each stone per depth level; split each level into listings of <=LOTS_PER_LISTING distinct stones (contract caps at 5, reverts 0xfe30bf0c past it)
  const listTxs = [];
  for (let i = 0; i < K; i++) { const row = perStone.map((c) => c[i]).filter(Boolean); for (let j = 0; j < row.length; j += LOTS_PER_LISTING) listTxs.push(row.slice(j, j + LOTS_PER_LISTING)); }
  const summary = perStone.map((c) => `${STONE_NAMES[c[0].stone]}×${c.reduce((s, l) => s + l.amount, 0)}@${fmtWei(c[0].price)}`).join(", ");
  if (cfg.dry) { log(`  DRY  would list ${summary} in ${listTxs.length} tx`); return; }
  for (let k = 0; k < listTxs.length; k++) { const lots = listTxs[k];
    await tx(A.market, data(S.list, ["uint256[]", "uint256[]", "uint256[]"], [lots.map((l) => l.stone), lots.map((l) => l.amount), lots.map((l) => l.price)]), `list ${k + 1}/${listTxs.length} (${lots.length} stone)`);
  }
  log(`  listed ${summary} in ${listTxs.length} tx`);
}

// --------------------------------------------------------------- runtime -----
async function loop(name, fn, everyMs) {
  for (;;) {
    try { await fn(); }
    catch (e) { log(`${name}: ${errStr(e)}`); }
    await sleep(everyMs);
  }
}
async function main() {
  if (!cfg.pk) { console.error("MARS_PK is required (your wallet private key, 0x...). See .env.example."); process.exit(1); }
  const net = new ethers.Network("robinhood", CHAIN);
  provider = new ethers.JsonRpcProvider(cfg.rpc, net, { staticNetwork: net });
  wallet = new ethers.Wallet(cfg.pk, provider);
  ME = ethers.getAddress(wallet.address);

  const eth = await provider.getBalance(ME).catch(() => 0n);
  log("================ Mars Bot ================");
  log(`wallet   ${ME}`);
  log(`mode     ${cfg.dry ? "DRY-RUN (no txs sent) — set MARS_DRY=0 to go live" : "LIVE"}`);
  log(`gas ETH  ${fmtWei(eth, 5)}`);
  log(`engines  farm=${cfg.farm ? "on" : "off"} market=${cfg.market ? "on" : "off"}`);
  if (cfg.farm) log(`  farm   keep ${cfg.targetRigs} rigs, fund from wallet DRILL${cfg.drillReserve ? ` (reserve ${cfg.drillReserve})` : ""}${cfg.maxSpend ? `, <=${cfg.maxSpend}/cycle` : ""}, external=${cfg.external}, every ${cfg.farmMs / 1000}s`);
  if (cfg.market) log(`  market ignore <${cfg.minLot}-qty asks + depth ${cfg.depthUnits}, keep <=${cfg.maxLots} lots (${cfg.maxLots * 99}) per stone, floor ${cfg.floorDrill} DRILL + best-bid, rebalance <= 1/${cfg.marketMs / 1000}s`);
  log("==========================================");

  if (cfg.farm) { try { await signIn(); } catch (e) { log(`sign-in failed (collect will retry): ${errStr(e)}`); } }

  const jobs = [];
  if (cfg.farm) jobs.push(loop("farm", engineFarm, cfg.farmMs));
  if (cfg.market) jobs.push(loop("market", engineMarket, 15000));   // checks often, but acts <= 1/min
  if (!jobs.length) { log("both engines disabled (MARS_FARM=0 and MARS_MARKET=0) — nothing to do"); return; }
  await Promise.all(jobs);
}
process.on("SIGINT", () => { log("shutting down"); process.exit(0); });
main().catch((e) => { console.error(e); process.exit(1); });
