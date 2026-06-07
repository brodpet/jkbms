import { useEffect, useRef, useState } from 'react'
import mqtt from 'mqtt'

const BROKER = 'wss://c3d042132d83410eacb912944246d4d7.s1.eu.hivemq.cloud:8884/mqtt'
const USERNAME = 'brodpet'
const PASSWORD = 'Brodpet18'
const PACKS = ['ED-48V-314AH-15']
const PACK_LABELS: Record<string, string> = {
  'ED-48V-314AH-15': 'ED 48V 314AH -15',
}

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

function SocBar({ pct }: { pct: number }) {
  const color = pct > 50 ? '#00ff99' : pct > 20 ? '#f9a825' : '#ff4444'
  return (
    <div style={{ background: '#0a1828', borderRadius: 4, height: 10, overflow: 'hidden', margin: '6px 0' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.5s' }} />
    </div>
  )
}

function CellGrid({ cells }: { cells: number[] }) {
  if (!cells?.length) return null
  const min = Math.min(...cells)
  const max = Math.max(...cells)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginTop: 8 }}>
      {cells.map((v, i) => {
        const isMin = v === min && min !== max
        const isMax = v === max && min !== max
        return (
          <div key={i} style={{
            background: isMin ? 'rgba(255,68,68,0.15)' : isMax ? 'rgba(0,255,153,0.12)' : '#0a1828',
            border: `1px solid ${isMin ? '#ff4444' : isMax ? '#00ff99' : '#1a2a40'}`,
            borderRadius: 3,
            padding: '4px 6px',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 9, color: '#4a6a8a', letterSpacing: 1 }}>C{i + 1}</div>
            <div style={{ fontSize: 12, color: isMin ? '#ff6666' : isMax ? '#00ff99' : '#a0c8e8', fontVariantNumeric: 'tabular-nums' }}>
              {v.toFixed(3)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PackCard({ name, data }: { name: string; data: PackData | undefined }) {
  const [expanded, setExpanded] = useState(false)
  const age = data ? Math.floor((Date.now() - data.updatedAt) / 1000) : null
  const stale = age !== null && age > 30

  return (
    <div style={{
      background: '#0a1420',
      border: `1px solid ${data && !stale ? '#1a3a5a' : '#2a1a1a'}`,
      borderRadius: 8,
      padding: 14,
      marginBottom: 12,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={{ fontFamily: 'monospace', fontSize: 11, letterSpacing: 2, color: '#00aaff' }}>
          {PACK_LABELS[name] ?? name}
        </div>
        <div style={{ fontSize: 10, color: stale ? '#ff4444' : data ? '#00ff99' : '#4a6a8a', letterSpacing: 1 }}>
          {data ? (stale ? `STALE ${age}s` : `${age}s ago`) : 'WAITING'}
        </div>
      </div>

      {data ? (
        <>
          <SocBar pct={data.soc} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 28, fontWeight: 700, color: data.soc > 50 ? '#00ff99' : data.soc > 20 ? '#f9a825' : '#ff4444' }}>
              {data.soc}%
            </span>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 16, color: '#d0e8ff' }}>{data.voltage.toFixed(2)}V</div>
              <div style={{ fontSize: 13, color: data.current < 0 ? '#f9a825' : '#00aaff' }}>
                {data.current > 0 ? '+' : ''}{data.current.toFixed(1)}A
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontSize: 11 }}>
            <Stat label="POWER" value={`${data.power.toFixed(0)}W`} />
            <Stat label="REMAIN" value={`${data.capacity.toFixed(1)}Ah`} />
            <Stat label="DELTA" value={`${(data.delta_cell * 1000).toFixed(0)}mV`} warn={data.delta_cell > 0.05} />
            <Stat label="TEMP 1" value={`${data.temp1.toFixed(1)}°C`} />
            <Stat label="TEMP 2" value={`${data.temp2.toFixed(1)}°C`} />
            <Stat label="MOSFET" value={`${data.mosfet_temp.toFixed(1)}°C`} warn={data.mosfet_temp > 60} />
          </div>

          <button
            onClick={() => setExpanded(e => !e)}
            style={{
              marginTop: 10,
              background: 'none',
              border: '1px solid #1a3a5a',
              borderRadius: 3,
              color: '#4a8aaa',
              fontSize: 10,
              letterSpacing: 2,
              padding: '4px 10px',
              cursor: 'pointer',
              width: '100%',
            }}
          >
            {expanded ? 'HIDE CELLS' : `SHOW ${data.cells.length} CELLS`}
          </button>

          {expanded && <CellGrid cells={data.cells} />}
        </>
      ) : (
        <div style={{ color: '#2a4a6a', fontSize: 12, padding: '12px 0', textAlign: 'center' }}>
          Waiting for data...
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ background: '#060d1a', borderRadius: 4, padding: '5px 7px' }}>
      <div style={{ fontSize: 9, color: '#3a5a7a', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 12, color: warn ? '#f9a825' : '#a0c8e8', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

export default function App() {
  const [packs, setPacks] = useState<PackMap>({})
  const [status, setStatus] = useState('Connecting...')
  const clientRef = useRef<mqtt.MqttClient | null>(null)

  useEffect(() => {
    const client = mqtt.connect(BROKER, {
      username: USERNAME,
      password: PASSWORD,
      reconnectPeriod: 5000,
    })
    clientRef.current = client

    client.on('connect', () => {
      setStatus('Connected')
      PACKS.forEach(p => client.subscribe(`jkbms/${p}`))
    })

    client.on('disconnect', () => setStatus('Disconnected'))
    client.on('error', (e) => setStatus(`Error: ${e.message}`))
    client.on('reconnect', () => setStatus('Reconnecting...'))

    client.on('message', (topic, payload) => {
      const pack = topic.replace('jkbms/', '')
      try {
        const data = JSON.parse(payload.toString())
        setPacks(prev => ({ ...prev, [pack]: { ...data, updatedAt: Date.now() } }))
      } catch {}
    })

    return () => { client.end() }
  }, [])

  const totalSoc = Object.values(packs).length
    ? Math.round(Object.values(packs).reduce((s, p) => s + p.soc, 0) / Object.values(packs).length)
    : null
  const totalPower = Object.values(packs).reduce((s, p) => s + p.power, 0)

  return (
    <div>
      <div style={{ textAlign: 'center', padding: '16px 0 20px' }}>
        <div style={{ fontFamily: 'monospace', fontSize: 10, letterSpacing: 4, color: '#004488', marginBottom: 4 }}>
          DONGJIN SOLAR
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 11, letterSpacing: 3, color: '#00aaff' }}>
          JK BMS MONITOR
        </div>
        {totalSoc !== null && (
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center', gap: 20 }}>
            <div>
              <div style={{ fontSize: 9, color: '#3a5a7a', letterSpacing: 2 }}>AVG SOC</div>
              <div style={{ fontSize: 22, color: totalSoc > 50 ? '#00ff99' : totalSoc > 20 ? '#f9a825' : '#ff4444' }}>
                {totalSoc}%
              </div>
            </div>
            <div>
              <div style={{ fontSize: 9, color: '#3a5a7a', letterSpacing: 2 }}>TOTAL POWER</div>
              <div style={{ fontSize: 22, color: '#00aaff' }}>{totalPower.toFixed(0)}W</div>
            </div>
          </div>
        )}
        <div style={{ fontSize: 9, color: status === 'Connected' ? '#00ff9955' : '#ff444455', letterSpacing: 2, marginTop: 8 }}>
          {status}
        </div>
      </div>

      {PACKS.map(name => (
        <PackCard key={name} name={name} data={packs[name]} />
      ))}

      <div style={{ textAlign: 'center', fontSize: 9, color: '#1a2a3a', letterSpacing: 2, padding: '16px 0' }}>
        UPDATES EVERY 10s
      </div>
    </div>
  )
}
