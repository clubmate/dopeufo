#!/usr/bin/env node
/**
 * Full-match playtest. Drives both teams with a simple bot through the REAL
 * game API in a real browser, until someone wins or we hit the turn cap.
 *
 * The unit tests prove the simulation is correct in isolation; this proves the
 * whole stack — rules driving units driving fx/audio/ui/camera — survives an
 * actual match without deadlocking, throwing, or leaking.
 *
 * Resilient to Vite HMR reloads: other agents editing source mid-run destroys
 * the page's execution context, which is not a game failure and must not be
 * reported as one.
 *
 * Usage: node tools/playtest.mjs [--turns 40] [--shots] [--url ...]
 */
import puppeteer from 'puppeteer'
import { mkdirSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, [])
)
const URL = args.url || 'http://localhost:5173'
const MAX_TURNS = parseInt(args.turns || '40', 10)
const WANT_SHOTS = !!args.shots
if (WANT_SHOTS) mkdirSync('shots/match', { recursive: true })

/** Installed into the page; plays both sides. */
function installBot() {
  const ctx = window.__CTX
  const g = ctx.state
  window.__LOG = window.__LOG || []
  const log = (s) => window.__LOG.push(s)

  const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms))
  const waitIdle = async (timeout = 12000) => {
    const t0 = performance.now()
    while (g.isBusy?.() && performance.now() - t0 < timeout) await settle(50)
    return !g.isBusy?.()
  }

  window.__playTurn = async () => {
    const team = g.activeTeam
    const mine = g.units.filter((u) => u.team === team && u.alive)
    for (const u of mine) {
      if (!g.canAct?.(u)) continue
      g.selectUnit(u.id)
      await settle(30)

      // Reload before anything else when dry. Without this the bot fires at an
      // empty magazine forever: the rules layer correctly refuses (canFire is
      // false on no ammo) but getTargets still lists visible enemies, so a
      // naive bot loops on a shot that can never happen. That looked exactly
      // like a combat bug and was not one.
      if (u.weapon && u.weapon.ammo <= 0) {
        log(`T${g.turn} team${team} ${u.name} RELOAD (mag empty)`)
        g.useAbility?.('reload')
        await waitIdle()
        continue
      }

      // Shoot if anything is in LOS.
      const targets = g.getTargets?.(u) || []
      if (targets.length) {
        const t = targets[0]
        const tid = t.id || t.unitId || t
        const tu = g.getUnit?.(tid) || t
        const pv = g.previewShot?.(u, tu)
        // Record the actual outcome, not just the intent. Logging "FIRE" before
        // the call made a rejected shot look identical to a resolved one, which
        // is what made an earlier stall look like a damage bug.
        const hpBefore = tu.hp
        const apBefore = u.ap
        const stateBefore =
          `phase=${g.phase} busy=${g.isBusy?.()} sel=${g.selectedUnitId} pend=${JSON.stringify(g.pendingAction)}` +
          ` canFire=${pv?.canFire} LOS=${pv?.hasLOS} inRange=${pv?.inRange} ammo=${pv?.hasAmmo}/${u.weapon?.ammo}` +
          ` canAct=${g.canAct?.(u)} turnEnded=${u.turnEnded} alive=${u.alive}/${tu.alive}`
        g.fireAt(tid)
        if (!(await waitIdle())) { log('  !! stuck after fire'); return 'stuck' }
        log(
          `T${g.turn} team${team} ${u.name} FIRE -> ${tid} (${pv?.hitChance ?? '?'}%)` +
            ` hp ${hpBefore}->${tu.hp} ap ${apBefore}->${u.ap}` +
            (u.ap === apBefore && tu.hp === hpBefore ? `  <<< NO EFFECT [${stateBefore}]` : '')
        )
        continue
      }

      // Otherwise close on the nearest living enemy.
      const enemies = g.units.filter((e) => e.team !== team && e.alive)
      if (!enemies.length) break
      const nearestEnemyDist = (x, z) =>
        Math.min(...enemies.map((e) => Math.max(Math.abs(x - e.x), Math.abs(z - e.z))))

      let best = null
      const reach = g.getReachable?.(u)
      const pool = reach ? [...(reach.blue || []), ...(reach.dash || [])] : []
      for (const key of pool) {
        const tile = typeof key === 'object' ? key : { x: key % 24, z: Math.floor(key / 24) }
        const d = nearestEnemyDist(tile.x, tile.z)
        if (!best || d < best.d) best = { d, tile }
      }

      // Advance whenever it strictly closes on the NEAREST enemy. An earlier
      // version compared against the farthest, so units froze mid-map.
      if (best && best.d < nearestEnemyDist(u.x, u.z)) {
        log(`T${g.turn} team${team} ${u.name} MOVE -> ${best.tile.x},${best.tile.z}`)
        g.moveTo(best.tile.x, best.tile.z)
        if (!(await waitIdle())) { log('  !! stuck after move'); return 'stuck' }
      } else {
        // Log the silent branch too. A turn spent here produces no MOVE/FIRE
        // line, which made an entire team look like it was being skipped.
        log(
          `T${g.turn} team${team} ${u.name} HOLD` +
            ` (reach=${pool.length} bestD=${best ? best.d : 'n/a'} hereD=${nearestEnemyDist(u.x, u.z)})`
        )
        g.useAbility?.('overwatch')
        await waitIdle(3000)
      }
    }
    // Only end the turn if it hasn't already ended itself. The rules auto-pass
    // to the other team once every unit is spent, so an unconditional endTurn()
    // here landed on the OPPONENT's freshly-started turn and burned it before
    // they could act — team 1 was skipped every single round and appeared never
    // to play at all.
    const teamBefore = g.activeTeam
    if (teamBefore !== team || g.phase === 'over') return 'ok'
    g.endTurn()
    await waitIdle()
    // The hand-over completes a little after isBusy() clears (turn banner and
    // per-unit refresh). Without waiting for activeTeam to actually flip, the
    // next call re-entered the SAME team's turn — every unit already spent, so
    // it produced no actions and no log lines, then ended the turn again and
    // consumed the other team's turn outright. Team 1 appeared never to play.
    const t0 = performance.now()
    while (g.activeTeam === teamBefore && g.phase !== 'over' && performance.now() - t0 < 3000) {
      await settle(40)
    }
    return 'ok'
  }
}

const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--no-sandbox', '--window-size=1600,900'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 900 })

const errors = []
page.on('pageerror', (e) => errors.push(String(e.message || e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

const isContextLost = (e) =>
  /Execution context was destroyed|Target closed|Cannot find context|detached/i.test(String(e?.message || e))

async function bootAndInstall() {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction('window.__READY === true', { timeout: 60000, polling: 100 })
  await page.evaluate(installBot)
}

await bootAndInstall()

const result = { turns: 0, winner: null, stuck: false, reloads: 0, log: [] }

for (let i = 0; i < MAX_TURNS; i++) {
  let r, snap
  try {
    r = await page.evaluate(() => window.__playTurn())
    snap = await page.evaluate(() => ({
      turn: window.__CTX.state.turn,
      team: window.__CTX.state.activeTeam,
      winner: window.__CTX.state.winner,
      phase: window.__CTX.state.phase,
      alive: window.__CTX.state.units.filter((u) => u.alive).map((u) => `${u.name}:${u.hp}`),
      fps: Math.round(window.__CTX.fps || 0),
    }))
  } catch (e) {
    if (!isContextLost(e)) throw e
    result.reloads++
    console.log(`  (page reloaded by HMR — reinstalling bot, reload #${result.reloads})`)
    await bootAndInstall()
    continue
  }

  result.turns = snap.turn
  if (WANT_SHOTS && i % 4 === 0) {
    await page.screenshot({ path: `shots/match/turn-${String(i).padStart(2, '0')}.png` }).catch(() => {})
  }
  console.log(`  turn ${String(snap.turn).padStart(2)} team${snap.team} fps ${snap.fps} | alive: ${snap.alive.join(' ')}`)
  if (r === 'stuck') { result.stuck = true; break }
  // Stop on phase as well as winner. Checking `winner` alone let a finished
  // match keep "playing": once phase is 'over' the rules layer correctly
  // refuses every action, so the bot logged fire intents that resolved to
  // nothing, turn after turn, and it read as a combat bug that wasn't one.
  if (snap.phase === 'over' || (snap.winner !== null && snap.winner !== undefined)) {
    result.winner = snap.winner
    result.phase = snap.phase
    break
  }
}

result.log = await page.evaluate(() => window.__LOG).catch(() => [])
await browser.close()

console.log('\n═══ MATCH RESULT ═══')
console.log(`  turns played : ${result.turns}`)
console.log(`  winner       : ${result.winner ?? 'none (turn cap)'}`)
console.log(`  deadlocked   : ${result.stuck}`)
console.log(`  hmr reloads  : ${result.reloads}`)
console.log(`  actions      : ${result.log.length}`)
console.log('\n  last 20 actions:')
result.log.slice(-20).forEach((l) => console.log(`    ${l}`))
const errs = [...new Set(errors)]
if (errs.length) {
  console.log(`\n═══ ${errs.length} ERROR(S) ═══`)
  errs.slice(0, 20).forEach((e) => console.log(`  - ${e.slice(0, 300)}`))
}
process.exit(result.stuck ? 1 : 0)
