# Mars Bot

A standalone Node.js bot that plays the paid loop of **Project Mars** (Robinhood
Chain, chainId 4663) for you — no browser required. Run it on your laptop or a
tiny AWS box. Because it isn't a browser it has **no CORS limits**, so it talks
to the game's own API the same way the game does.

Two independent engines:

| Engine | What it does |
|--------|--------------|
| **farm** | Keeps Hauler rigs planted on your empty plots and **auto-collects every ready tray**. |
| **market** | Keeps every stone you hold **listed 1 wei under the best ask that isn't yours**, re-pricing at most once per minute. |

Either can run alone (`MARS_FARM=0` or `MARS_MARKET=0`).

## How auto-collect is possible without the game

Collecting a tray needs the game's **reveal signature**. The randomness for what
ore a rig finds is `blockhash(revealBlock)`, and on a ~100 ms chain that hash is
forgotten after 256 blocks (~25 s). So the game's backend (the *reveal signer*)
attests the hash and returns a signature from an auth-gated endpoint,
`GET /api/words`.

A browser tool can't reach that endpoint (CORS + auth). A standalone script can:
it performs a **Sign-In With Ethereum (EIP-4361)** handshake using *your own key*
(`/api/nonce` → `personal_sign` → `/api/session` → bearer token), then calls
`/api/words` and gets **your own** trays' signatures — exactly the call the game
makes. It then sends `collect(nonces[], blockHashes[], signatures[])` on-chain.
Your key never leaves the machine; the signature is over a login message, not a
transfer.

## How the market engine prices

Each cycle it reads the full order book from `/api/book`, then for every stone
you hold computes the **best ask that isn't yours**, with two dedust layers so
thin liquidity can't drag the price down:

1. **skip any ask lot smaller than `MARS_MIN_LOT` units** (default 2 — kills
   qty-1 pollution outright, even a whole wall of it), then
2. of what's left, **take the price only once cumulative depth reaches
   `MARS_DEPTH` units** (default 10).

The cheapest ("front") rung goes **1 wei under** that price, keeping up to
`MARS_MAX_LOTS` lots of depth per stone. As that depth sells it's replenished
from your wallet — so inventory drains steadily instead of dumping thousands of
units at once. (If a stone's *only* asks are below `MARS_MIN_LOT`, it's treated
as having no real ask and is left unlisted — set `MARS_MIN_LOT=1` to price off
qty-1 asks too.)

**It auto-ladders, for free.** The contract caps a single lot at 99 units and
forbids the same stone id twice in one listing, so any depth over 99 is *already*
forced across separate listings. The bot prices those forced rungs up a gentle
geometric curve (+4%/rung, capped at +100%) instead of stacking them all at one
price. That means only the front slice sits at the best ask; the rest waits
higher up, so a buyer sweeping 5–10% of your book can't walk your quoted price
down — and it costs no extra transactions, because those listings had to exist
anyway. A 1090-unit position becomes twelve 99-lots laddered 5.28 → 8.13, in the
same tx count as a flat wall. Guards:

- **Never below the best bid** (and never below `MARS_FLOOR_DRILL`) — a troll
  dust ask can't make it dump your inventory.
- **≤ 1 rebalance per minute**, and only when the ladder actually drifted — the
  front *or* top rung off target by more than 8% — or you collected meaningfully
  more ore. So it won't churn gas or start an every-block undercut war, and a
  flat wall left over from a manual listing gets pulled into a proper ladder on
  the next cycle.

It manages your sell side end-to-end: a rebalance cancels your existing listings
(returning escrow to the wallet) and re-lists the fresh ladder, bin-packing up
to 5 distinct stones per `list()` tx.

## Setup

```bash
cd bot
npm install                 # installs ethers v6
cp .env.example .env        # then edit .env — set MARS_PK at minimum
```

Run (dry-run is the default — it simulates every tx and sends nothing):

```bash
set -a && source .env && set +a
node mars-bot.mjs           # or: npm run dry
```

Go live once the dry-run output looks right:

```bash
MARS_DRY=0 node mars-bot.mjs   # or set MARS_DRY=0 in .env, then: npm run live
```

On Node ≥ 20 you can skip the `source` step with `node --env-file=.env mars-bot.mjs`.

## Safety

- **Dry-run by default.** Nothing is sent until you set `MARS_DRY=0`.
- **Every write is `eth_call`-simulated first.** A revert is logged and the tx is
  not sent — so a contested plot or stale listing can't waste gas.
- **Paid planting spends your wallet DRILL** to keep rigs planted up to the
  100-rig cap. It's bounded and self-funding — at most ~100 rigs in flight, and
  each collect returns ~96% of a rig's cost plus its ore. Set
  `MARS_DRILL_RESERVE` to hold back a buffer, or `MARS_MAX_SPEND` to cap
  per-cycle spend.
- You need a little **ETH for gas** in the wallet; the startup banner prints your
  balance.
- Keys are read from `MARS_PK` only and never logged. Keep `.env` out of git
  (already covered by `.gitignore`).

## Config

See `.env.example` for the full list. The common knobs:

| Var | Default | Meaning |
|-----|---------|---------|
| `MARS_PK` | — | **required** wallet key |
| `MARS_DRY` | `1` | `0` to send real transactions |
| `MARS_FARM` / `MARS_MARKET` | `1` | enable each engine |
| `MARS_TARGET_RIGS` | `100` | rigs to keep planted (cap 100) |
| `MARS_MAX_SPEND` | `0` | optional cap on paid DRILL/cycle (`0` = spend all) |
| `MARS_DRILL_RESERVE` | `0` | DRILL to keep unspent |
| `MARS_EXTERNAL` | `0` | plant on others' open plots when yours run out |
| `MARS_MIN_LOT` | `2` | ignore ask lots smaller than this (qty-1 dust) |
| `MARS_DEPTH` | `10` | cumulative depth the reference ask must reach |
| `MARS_MAX_LOTS` | `3` | sell-side depth per stone, in lots of 99 |
| `MARS_FLOOR_DRILL` | `0` | extra price floor per stone |

## Running on AWS

It's a single process with no inbound ports. On a `t4g.nano`:

```bash
sudo dnf install -y nodejs        # or apt on Ubuntu
git clone <this repo> && cd mars-tool/bot && npm install
# put your .env here (chmod 600 .env), then run under a supervisor:
node --env-file=.env mars-bot.mjs
```

Keep it alive with `pm2 start mars-bot.mjs --node-args=--env-file=.env`, a
`systemd` unit, or `screen`/`tmux`.

## Notes / limits

- Auto-collect grabs **all** ready trays (every tier), not just haulers — leaving
  free ore on the table would be silly. The farm only *plants* haulers.
- The bot never burns plots and never sells into bids; it only plants, collects,
  lists, cancels, and re-lists.
- `/api/plots` and `/api/book` are lightly cached snapshots; the on-chain
  simulation before each tx is the real guard against acting on stale data.
