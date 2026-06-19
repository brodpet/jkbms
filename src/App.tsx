import { useEffect, useMemo, useRef, useState } from 'react'
import mqtt from 'mqtt'

const BROKER = 'wss://c3d042132d83410eacb912944246d4d7.s1.eu.hivemq.cloud:8884/mqtt'
const USERNAME = 'brodpet'
const PASSWORD = 'Brodpet18'
const PACKS = ['ED-48V-314AH-15']
const PACK_LABELS: Record<string, string> = {
  'ED-48V-314AH-15': 'ED 48V 314AH -15',
}
const NOMINAL_AH = 314

interface PackData {
  soc: number
  voltage: number
  current: number
  power: number
  temp1: number
  temp2: number
  mosfet_temp: number
  capacity: number
  min_cell: number
  max_cell: number
  delta_cell: number
  cells: number[]
  updatedAt: number
}

type PackMap = Record<string, PackData>
type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'error' | 'offline'

/* ---------- helpers ---------- */
function fmt(n: number, d: number): string {
  return Number(n).toFixed(d)
}

function socColor(pct: number): string {
  return pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--amber)' : 'var(--red)'
}

function fmtTime(h: number): string {
  if (!isFinite(h) || h < 0) return '—'
  if (h >= 48) {
    const d = Math.floor(h / 24)
    return d + 'd ' + Math.floor(h % 24) + 'h'
  }
  if (h >= 10) return fmt(h, 0) + 'h'
  const hh = Math.floor(h)
  const mm = Math.round((h - hh) * 60)
  return hh + 'h ' + String(mm).padStart(2, '0') + 'm'
}

/* estimate time to full / empty from SOC + current + nominal capacity */
function etaFor(soc: number, current: number): { hours: number; mode: 'charge' | 'discharge' | 'idle'; label: string; color: string; ah: number } {
  const absI = Math.abs(current)
  if (absI < 0.5) {
    return { hours: NaN, mode: 'idle', label: 'Est. Time', color: 'var(--blue)', ah: 0 }
  }
  if (current > 0) {
    const ah = (NOMINAL_AH * (100 - soc)) / 100
    return { hours: ah / absI, mode: 'charge', label: 'Est. to Full', color: 'var(--green)', ah }
  }
  const ah = Math.max(0, (NOMINAL_AH * (soc - 20)) / 100)
  return { hours: ah / absI, mode: 'discharge', label: 'Est. to Discharge', color: 'var(--amber)', ah }
}

/* ---------- top bar ---------- */
function TopBar({ status, clock }: { status: ConnState; clock: string }) {
  const map: Record<ConnState, { cls: string; text: string }> = {
    connecting: { cls: 'connecting', text: 'CONNECTING' },
    connected: { cls: 'connected', text: 'CONNECTED' },
    reconnecting: { cls: 'connecting', text: 'RECONNECTING' },
    error: { cls: 'error', text: 'ERROR' },
    offline: { cls: 'offline', text: 'OFFLINE' },
  }
  const s = map[status]
  return (
    <div className="topbar">
      <div className="brand">
        <div className="logo">JK</div>
        <div className="titles">
          <div className="name">ED Solar</div>
          <div className="sub">JK BMS Monitor</div>
        </div>
      </div>
      <div className="topbar-right">
        <span className="clock">{clock}</span>
        <span className={`status-pill ${s.cls}`}>
          <span className="dot"></span> {s.text}
        </span>
      </div>
    </div>
  )
}

/* ---------- summary card ---------- */
function SumCard({
  label, value, unit, color, delta, accent, placeholder,
}: {
  label: string
  value: string
  unit?: string
  color?: string
  delta?: string
  accent: string
  placeholder?: boolean
}) {
  return (
    <div className={`sum-card${placeholder ? ' placeholder' : ''}`}>
      <div className="accent-bar" style={{ background: accent }}></div>
      <div className="label">{label}</div>
      <div className="value" style={{ color }}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {delta && <div className="delta">{delta}</div>}
    </div>
  )
}

/* ---------- circular SOC gauge ---------- */
function Gauge({ pct, color }: { pct: number; color: string }) {
  const circ = 2 * Math.PI * 74 // 464.96
  const clamped = Math.max(0, Math.min(100, pct))
  const off = circ * (1 - clamped / 100)
  const grad = color === 'var(--green)'
  return (
    <div className="gauge">
      <svg width="168" height="168" viewBox="0 0 168 168">
        <circle cx="84" cy="84" r="74" fill="none" stroke="rgba(40,80,130,0.25)" strokeWidth="12" />
        <circle
          cx="84" cy="84" r="74" fill="none"
          stroke={grad ? 'url(#g)' : color}
          strokeWidth="12" strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={off}
          style={{ transition: 'stroke-dashoffset .6s ease, stroke .3s ease' }}
        />
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2ea8ff" />
            <stop offset="100%" stopColor="#00ff99" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  )
}

/* ---------- trend chart ---------- */
function TrendChart({ powHist, voltHist }: { powHist: number[]; voltHist: number[] }) {
  const W = 400, H = 180, pad = 8
  const n = powHist.length
  if (n < 2) {
    return <div className="chart-empty">COLLECTING DATA…</div>
  }
  const pMax = Math.max(...powHist, 1) * 1.15
  const pMin = Math.min(...powHist, 0)
  const vMax = Math.max(...voltHist)
  const vMin = Math.min(...voltHist)
  const vR = vMax - vMin || 1

  const x = (i: number) => pad + (i / (n - 1)) * (W - 2 * pad)
  const yP = (v: number) => H - pad - ((v - pMin) / ((pMax - pMin) || 1)) * (H - 2 * pad)
  const yV = (v: number) => H - pad - ((v - vMin) / vR) * (H - 2 * pad)

  const linePath = (arr: number[], yf: (v: number) => number) =>
    arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + yf(v).toFixed(1)).join(' ')
  const areaPath = (arr: number[], yf: (v: number) => number) =>
    linePath(arr, yf) + ` L${x(n - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="pa" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(249,168,37,0.35)" />
            <stop offset="100%" stopColor="rgba(249,168,37,0)" />
          </linearGradient>
        </defs>
        <path d={areaPath(powHist, yP)} fill="url(#pa)" />
        <path d={linePath(powHist, yP)} fill="none" stroke="#f9a825" strokeWidth="2" />
        <path d={linePath(voltHist, yV)} fill="none" stroke="#2ea8ff" strokeWidth="2" strokeDasharray="3 3" />
      </svg>
    </div>
  )
}

/* ---------- cell grid ---------- */
function CellGrid({ cells }: { cells: number[] }) {
  if (!cells?.length) return null
  const min = Math.min(...cells)
  const max = Math.max(...cells)
  return (
    <div className="cells">
      {cells.map((v, i) => {
        const isMin = v === min && min !== max
        const isMax = v === max && min !== max
        const cls = 'cell' + (isMin ? ' min' : isMax ? ' max' : '')
        return (
          <div key={i} className={cls}>
            <div className="id">C{String(i + 1).padStart(2, '0')}</div>
            <div className="v">{v.toFixed(3)}</div>
          </div>
        )
      })}
    </div>
  )
}

/* ---------- hero pack card ---------- */
function PackCard({ name, data }: { name: string; data: PackData | undefined }) {
  const color = data ? socColor(data.soc) : 'var(--blue)'

  const state = useMemo(() => {
    if (!data) return null
    if (data.current > 0.5) return { t: 'CHARGING', c: 'charging' }
    if (data.current < -0.5) return { t: 'DISCHARGING', c: 'discharging' }
    return { t: 'IDLE', c: 'idle' }
  }, [data])

  return (
    <div className="card">
      <div className="card-head">
        <div className="title">Battery Pack</div>
        <div className={`tag ${data ? 'live' : ''}`}>{data ? '● LIVE' : 'WAITING'}</div>
      </div>

      <div className="pack-head">
        <div>
          <div className="pack-id">{name}</div>
          <div className="pack-title">{PACK_LABELS[name] ?? name}</div>
          <div className="pack-sub">LiFePO4 · {(NOMINAL_AH * 3.2 * 16 / 1000).toFixed(1)} kWh nominal</div>
        </div>
      </div>

      <div className="gauge-wrap">
        <div style={{ position: 'relative', width: 168, height: 168 }}>
          <Gauge pct={data?.soc ?? 0} color={color} />
          <div className="center" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div className="soc-num" style={{ color }}>
              {data ? data.soc + '%' : '—'}
            </div>
            <div className="soc-lbl">STATE OF CHARGE</div>
            {state && <div className={`state ${state.c}`}>{state.t}</div>}
          </div>
        </div>

        <div className="hero-stats">
          <div className="hero-stat">
            <div className="l">VOLTAGE</div>
            <div className="v">{data ? fmt(data.voltage, 2) : '—'} <span className="u">V</span></div>
          </div>
          <div className="hero-stat">
            <div className="l">CURRENT</div>
            <div className="v" style={{ color: data ? (data.current < 0 ? 'var(--amber)' : data.current > 0 ? 'var(--green)' : 'var(--text)') : undefined }}>
              {data ? (data.current > 0 ? '+' : '') + fmt(data.current, 1) : '—'} <span className="u">A</span>
            </div>
          </div>
          <div className="hero-stat">
            <div className="l">POWER</div>
            <div className="v" style={{ color: data ? (data.power > 0 ? 'var(--green)' : data.power < 0 ? 'var(--amber)' : 'var(--text)') : undefined }}>
              {data ? (data.power > 0 ? '+' : '') + fmt(data.power, 0) : '—'} <span className="u">W</span>
            </div>
          </div>
          <div className="hero-stat">
            <div className="l">CELL DELTA</div>
            <div className="v" style={{ color: data && data.delta_cell > 0.05 ? 'var(--amber)' : undefined }}>
              {data ? fmt(data.delta_cell * 1000, 0) : '—'} <span className="u">mV</span>
            </div>
          </div>
        </div>
      </div>

      <div className="temps">
        <div className="temp-tile">
          <div className="ic">🌡️</div>
          <div className="l">PROBE 1</div>
          <div className="v" style={{ color: data && data.temp1 > 55 ? 'var(--red)' : data && data.temp1 > 45 ? 'var(--amber)' : undefined }}>
            {data ? fmt(data.temp1, 1) + ' °C' : '— °C'}
          </div>
        </div>
        <div className="temp-tile">
          <div className="ic">🌡️</div>
          <div className="l">PROBE 2</div>
          <div className="v" style={{ color: data && data.temp2 > 55 ? 'var(--red)' : data && data.temp2 > 45 ? 'var(--amber)' : undefined }}>
            {data ? fmt(data.temp2, 1) + ' °C' : '— °C'}
          </div>
        </div>
        <div className="temp-tile">
          <div className="ic">⚙️</div>
          <div className="l">MOSFET</div>
          <div className="v" style={{ color: data && data.mosfet_temp > 70 ? 'var(--red)' : data && data.mosfet_temp > 55 ? 'var(--amber)' : undefined }}>
            {data ? fmt(data.mosfet_temp, 1) + ' °C' : '— °C'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [packs, setPacks] = useState<PackMap>({})
  const [status, setStatus] = useState<ConnState>('connecting')
  const [clock, setClock] = useState('--:--:--')
  const [now, setNow] = useState(Date.now())
  const clientRef = useRef<mqtt.MqttClient | null>(null)

  /* trend buffers (power + voltage) */
  const [powHist, setPowHist] = useState<number[]>([])
  const [voltHist, setVoltHist] = useState<number[]>([])

  useEffect(() => {
    const client = mqtt.connect(BROKER, {
      username: USERNAME,
      password: PASSWORD,
      reconnectPeriod: 5000,
    })
    clientRef.current = client

    client.on('connect', () => {
      setStatus('connected')
      PACKS.forEach((p) => client.subscribe(`jkbms/${p}`))
    })
    client.on('reconnect', () => setStatus('reconnecting'))
    client.on('close', () => setStatus((s) => (s === 'error' ? s : 'offline')))
    client.on('error', () => setStatus('error'))
    client.on('disconnect', () => setStatus('offline'))

    client.on('message', (topic, payload) => {
      const pack = topic.replace('jkbms/', '')
      try {
        const data = JSON.parse(payload.toString())
        setPacks((prev) => ({ ...prev, [pack]: { ...data, updatedAt: Date.now() } }))
      } catch {
        /* ignore malformed payload */
      }
    })

    return () => {
      client.end()
    }
  }, [])

  /* tickers: clock + re-render for staleness */
  useEffect(() => {
    const t = setInterval(() => {
      const d = new Date()
      const p = (x: number) => String(x).padStart(2, '0')
      setClock(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`)
      setNow(Date.now())
    }, 1000)
    return () => clearInterval(t)
  }, [])

  /* sample the latest pack reading into the trend buffers every 2s */
  const primary = packs[PACKS[0]]
  useEffect(() => {
    if (!primary) return
    setPowHist((h) => {
      const next = [...h, primary.power]
      return next.length > 60 ? next.slice(next.length - 60) : next
    })
    setVoltHist((h) => {
      const next = [...h, primary.voltage]
      return next.length > 60 ? next.slice(next.length - 60) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.updatedAt])

  /* aggregate / derived values */
  const vals = Object.values(packs)
  const totalSoc = vals.length ? Math.round(vals.reduce((s, p) => s + p.soc, 0) / vals.length) : null
  const totalPower = vals.reduce((s, p) => s + p.power, 0)
  const totalCurrent = vals.reduce((s, p) => s + p.current, 0)
  const avgVoltage = vals.length ? vals.reduce((s, p) => s + p.voltage, 0) / vals.length : 0
  const remainingAh = vals.length ? vals.reduce((s, p) => s + p.capacity, 0) : 0

  const age = primary ? Math.floor((now - primary.updatedAt) / 1000) : null
  const stale = age !== null && age > 30
  const eta = totalSoc !== null ? etaFor(totalSoc, totalCurrent) : null

  const socDeltaText = totalCurrent > 0.5 ? '▲ charging' : totalCurrent < -0.5 ? '▼ discharging' : '◆ idle'

  return (
    <div className="app">
      <TopBar status={status} clock={clock} />

      <div className="summary">
        <SumCard
          label="Avg SOC"
          value={totalSoc !== null ? String(totalSoc) : '—'}
          unit={totalSoc !== null ? '%' : undefined}
          color={totalSoc !== null ? socColor(totalSoc) : undefined}
          delta={vals.length ? socDeltaText : undefined}
          accent="var(--green)"
          placeholder={!vals.length}
        />
        <SumCard
          label="Pack Voltage"
          value={vals.length ? fmt(avgVoltage, 2) : '—'}
          unit={vals.length ? 'V' : undefined}
          color="var(--blue)"
          delta="16S LiFePO4"
          accent="var(--blue)"
          placeholder={!vals.length}
        />
        <SumCard
          label="Total Power"
          value={vals.length ? (totalPower > 0 ? '+' : '') + fmt(totalPower, 0) : '—'}
          unit={vals.length ? 'W' : undefined}
          color={vals.length ? (totalPower > 0 ? 'var(--green)' : totalPower < 0 ? 'var(--amber)' : 'var(--blue)') : undefined}
          delta={vals.length ? fmt(Math.abs(totalPower / 1000), 2) + ' kW ' + (totalCurrent >= 0 ? 'in' : 'out') : undefined}
          accent="var(--amber)"
          placeholder={!vals.length}
        />
        <SumCard
          label="Remaining"
          value={vals.length ? fmt(remainingAh, 0) : '—'}
          unit={vals.length ? 'Ah' : undefined}
          color="#c89bff"
          delta={`${NOMINAL_AH} Ah nominal`}
          accent="#b48bff"
          placeholder={!vals.length}
        />
        <SumCard
          label={eta ? eta.label : 'Est. Time'}
          value={eta && !isNaN(eta.hours) ? fmtTime(eta.hours) : '—'}
          color={eta?.color}
          delta={
            eta && !isNaN(eta.hours)
              ? `${totalPower > 0 ? '+' : ''}${fmt(totalPower, 0)} W`
              : 'idle · no current'
          }
          accent={eta?.color ?? 'var(--blue)'}
          placeholder={!eta}
        />
      </div>

      <div className="grid">
        <PackCard name={PACKS[0]} data={primary} />

        <div className="card">
          <div className="card-head">
            <div className="title">Power &amp; Voltage Trend</div>
            <div className="tag">{stale ? `${age}s STALE` : 'LAST 5 MIN'}</div>
          </div>
          <TrendChart powHist={powHist} voltHist={voltHist} />
          <div className="chart-legend">
            <span><span className="legend-dot" style={{ background: 'var(--amber)' }}></span>Power (W)</span>
            <span><span className="legend-dot" style={{ background: 'var(--blue)' }}></span>Voltage (V)</span>
          </div>

          <div className="card-head" style={{ marginTop: 22 }}>
            <div className="title">Cell Voltages</div>
            <div className="tag">{primary?.cells.length ?? 0} CELLS</div>
          </div>
          {primary ? <CellGrid cells={primary.cells} /> : (
            <div className="chart-empty">WAITING FOR DATA…</div>
          )}

          {primary && (
            <div className="delta-bar">
              <span className="l">MAX − MIN CELL SPREAD</span>
              <span className="v" style={{ color: primary.delta_cell > 0.08 ? 'var(--red)' : primary.delta_cell > 0.05 ? 'var(--amber)' : 'var(--green)' }}>
                {fmt(primary.delta_cell * 1000, 0)} mV
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="footer">JK BMS MONITOR · LIVE MQTT · UPDATES EVERY 10s</div>
    </div>
  )
}
