"use client";

import {
  Activity,
  ArrowUpRight,
  Blocks,
  Check,
  ChevronDown,
  CircleDollarSign,
  Copy,
  Crosshair,
  ExternalLink,
  Gauge,
  Layers3,
  Menu,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Range = "24H" | "7D" | "30D" | "ALL";
type TxStatus = "landed" | "missed";
type LaneKey =
  | "orders"
  | "lifecycle"
  | "fwa"
  | "pull"
  | "group_pull"
  | "other";
type Transaction = {
  hash: string;
  fullHash?: string;
  laneKey: LaneKey;
  lane: string;
  contract: string;
  strategy: string;
  accent: string;
  time: string;
  relative: string;
  block: string;
  reward: number;
  cost: number;
  net: number;
  status: TxStatus;
  calls: string[];
  gas: string;
  bid: string;
  batchId?: string;
  batchLabel?: string;
  batchIndex?: number;
  batchSize?: number;
};
type TableRow =
  | { kind: "transaction"; tx: Transaction }
  | { kind: "batch"; id: string; label: string; members: Transaction[] };
type PnlPoint = {
  label: string;
  short: string;
  pnl: number;
  orders: number;
  lifecycle: number;
  fwa: number;
  pull: number;
  group_pull: number;
  other: number;
  revenue?: number;
  cost?: number;
};
type DashboardApiResponse = {
  generatedAt: string;
  ethUsd: number;
  summary: {
    receiptProfitUsd: number;
    receiptProfitEth: number;
    receiptCount: number;
    batchAttempts: number;
    batchWins: number;
    batchWinRate: number;
    relayAttempts: number;
    relayAccepted: number;
    relayDeliveryRate: number;
  };
  execution: {
    lastPassAt: string;
    lastBlock: string;
    viable: number;
    sent: number;
    confirmed: number;
    activeRuns: number;
    signerLeases: number;
    passFailures24h: number;
  };
  lanes: Array<{ key: LaneKey; value: number; chartValue: number }>;
  relays: Array<{ relayIndex: number; attempted: number; accepted: number }>;
  pnl: PnlPoint[];
  pnlHourly: PnlPoint[];
  transactions: Transaction[];
};

const laneDefinitions: Array<{
  key: LaneKey;
  label: string;
  contract: string;
  strategy: string;
  color: string;
}> = [
  { key: "orders", label: "Standing orders", contract: "PullStandingOrder", strategy: "crank()", color: "#b7f34a" },
  { key: "lifecycle", label: "Pool lifecycle", contract: "PullPool", strategy: "process → sync → settle", color: "#6ce5d7" },
  { key: "fwa", label: "FWA backruns", contract: "FWA + PullPool", strategy: "fulfill → settle", color: "#8ba6ff" },
  { key: "pull", label: "Pool pull", contract: "PullPool", strategy: "buyTickets → pull", color: "#c5a7ff" },
  { key: "group_pull", label: "GroupPull", contract: "GroupPull", strategy: "close → submit → collect", color: "#ffb35c" },
  { key: "other", label: "Additional lanes", contract: "Convex / Liquity / other", strategy: "enabled keeper work", color: "#65706a" },
];

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <span>{label}</span>
      {payload.map((item) => (
        <strong key={item.dataKey} style={{ color: item.color }}>
          {item.dataKey === "pnl" ? "Net P&L" : item.dataKey}: {formatUsd(item.value)}
        </strong>
      ))}
    </div>
  );
}

function TransactionTableRow({
  tx,
  selected,
  nested = false,
  onSelect,
}: {
  tx: Transaction;
  selected: boolean;
  nested?: boolean;
  onSelect: (tx: Transaction) => void;
}) {
  return (
    <tr className={`${selected ? "row-selected" : ""} ${nested ? "batch-member-row" : ""}`}>
      <td>
        <button className="tx-hash" onClick={() => onSelect(tx)}>
          <span>{nested && <i className="batch-elbow" />}{tx.hash}</span>
          {nested && <small>receipt {tx.batchIndex} of {tx.batchSize}</small>}
        </button>
      </td>
      <td>
        <span className="lane-name">
          <i style={{ background: tx.accent }} />
          <span>
            {tx.contract}
            <small>{tx.strategy}()</small>
          </span>
        </span>
      </td>
      <td className="mono">{tx.block}</td>
      <td className="mono">
        <time className="relative-time" title={`${tx.time} MT`}>{tx.relative}</time>
      </td>
      <td className="numeric mono">{tx.reward ? formatUsd(tx.reward) : "—"}</td>
      <td className="numeric mono muted">{tx.cost ? `−${formatUsd(tx.cost)}` : "—"}</td>
      <td className={`numeric mono ${tx.net > 0 ? "profit" : tx.net < 0 ? "loss" : ""}`}>
        {tx.net > 0 ? `+${formatUsd(tx.net)}` : tx.net < 0 ? `−${formatUsd(Math.abs(tx.net))}` : "—"}
      </td>
      <td>
        <span className={`status-badge ${tx.status}`}>
          <i /> {tx.status === "landed" ? "Landed" : "Missed"}
        </span>
      </td>
    </tr>
  );
}

export default function Home() {
  const [liveData, setLiveData] = useState<DashboardApiResponse | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("30D");
  const [chartMode, setChartMode] = useState<"cumulative" | "contribution">("cumulative");
  const [activePnlLanes, setActivePnlLanes] = useState<LaneKey[]>(laneDefinitions.map((lane) => lane.key));
  const [txFilter, setTxFilter] = useState<"all" | TxStatus>("all");
  const [txLaneFilter, setTxLaneFilter] = useState<"all" | LaneKey>("all");
  const [query, setQuery] = useState("");
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/dashboard", {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) setTelemetryError(`Telemetry request failed (${response.status})`);
          return;
        }
        const data = (await response.json()) as DashboardApiResponse;
        if (!cancelled) {
          setLiveData(data);
          setTelemetryError(null);
        }
      } catch {
        if (!cancelled) setTelemetryError("Telemetry is unavailable");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const chartData = useMemo(() => {
    const source = range === "24H" ? liveData?.pnlHourly ?? [] : liveData?.pnl ?? [];
    const ranged = range === "7D" ? source.slice(-7) : source;
    return ranged.reduce<Array<PnlPoint & { activePnl: number }>>((points, point) => {
      const interval = activePnlLanes.reduce((total, lane) => total + point[lane], 0);
      const cumulative = (points.at(-1)?.activePnl ?? 0) + interval;
      points.push({ ...point, activePnl: Number(cumulative.toFixed(2)) });
      return points;
    }, []);
  }, [activePnlLanes, liveData, range]);

  const filteredTransactions = useMemo(() => {
    const source = liveData?.transactions ?? [];
    return source.filter((tx) => {
      const statusMatch = txFilter === "all" || tx.status === txFilter;
      const laneMatch = txLaneFilter === "all" || tx.laneKey === txLaneFilter;
      const queryMatch = `${tx.hash} ${tx.fullHash ?? ""} ${tx.lane} ${tx.contract} ${tx.strategy} ${tx.block}`
        .toLowerCase()
        .includes(query.toLowerCase());
      return statusMatch && laneMatch && queryMatch;
    });
  }, [liveData, query, txFilter, txLaneFilter]);

  const tableRows = useMemo<TableRow[]>(() => {
    const seenBatches = new Set<string>();
    const rows: TableRow[] = [];
    for (const tx of filteredTransactions) {
      if (!tx.batchId) {
        rows.push({ kind: "transaction", tx });
        continue;
      }
      if (seenBatches.has(tx.batchId)) continue;
      seenBatches.add(tx.batchId);
      rows.push({
        kind: "batch",
        id: tx.batchId,
        label: tx.batchLabel ?? tx.batchId,
        members: filteredTransactions.filter((member) => member.batchId === tx.batchId),
      });
    }
    return rows;
  }, [filteredTransactions]);

  const displayLaneData = useMemo(() => {
    return laneDefinitions.map((lane) => {
      const telemetry = liveData?.lanes.find((item) => item.key === lane.key);
      return {
        key: lane.key,
        name: lane.label,
        short: lane.label,
        value: telemetry?.value ?? 0,
        chartValue: telemetry?.chartValue ?? 0,
        fill: lane.color,
      };
    });
  }, [liveData]);

  const profitableLaneTotal = displayLaneData.reduce(
    (total, lane) => total + Math.max(0, lane.value),
    0,
  );
  const leadingLane = [...displayLaneData]
    .sort((left, right) => right.value - left.value)
    .find((lane) => lane.value > 0);
  const leadingLaneShare =
    leadingLane && profitableLaneTotal > 0
      ? (Math.max(0, leadingLane.value) / profitableLaneTotal) * 100
      : 0;

  const displayRelayData = liveData
    ? liveData.relays.map((relay, index) => ({
        relay: `Relay ${relay.relayIndex + 1}`,
        attempted: relay.attempted,
        landed: relay.accepted,
        color: laneDefinitions[index % laneDefinitions.length].color,
      }))
    : [];

  const lastPassFresh = liveData?.execution.lastPassAt
    ? Date.parse(liveData.generatedAt) - Date.parse(liveData.execution.lastPassAt) < 60_000
    : false;
  const signerHealthy = Boolean(
    liveData &&
      !telemetryError &&
      liveData.execution.activeRuns === 1 &&
      liveData.execution.signerLeases === 1 &&
      lastPassFresh,
  );
  const healthScore = liveData
    ? [
        lastPassFresh,
        liveData.execution.activeRuns === 1,
        liveData.execution.signerLeases === 1,
        liveData.execution.passFailures24h === 0,
      ].filter(Boolean).length / 4
    : 0;

  const displayHealthEvents = liveData
    ? [
        {
          time: liveData.execution.lastPassAt
            ? new Date(liveData.execution.lastPassAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })
            : "—",
          title: "Latest pass",
          meta: `block ${liveData.execution.lastBlock || "—"} · ${liveData.execution.viable} viable · ${liveData.execution.sent} sent`,
          tone: lastPassFresh ? "good" : "warning",
        },
        {
          time: "NOW",
          title: "Signer lease",
          meta: `${liveData.execution.signerLeases} held · ${liveData.execution.activeRuns} active run`,
          tone:
            liveData.execution.signerLeases === 1 && liveData.execution.activeRuns === 1
              ? "good"
              : "warning",
        },
        {
          time: "24H",
          title: "Keeper pass failures",
          meta: `${liveData.execution.passFailures24h} recorded`,
          tone: liveData.execution.passFailures24h === 0 ? "good" : "warning",
        },
        {
          time: "7D",
          title: "Relay delivery",
          meta: `${liveData.summary.relayAccepted}/${liveData.summary.relayAttempts} submissions accepted`,
          tone: liveData.summary.relayAccepted > 0 ? "accent" : "warning",
        },
      ]
    : [];

  const togglePnlLane = (lane: LaneKey) => {
    setActivePnlLanes((current) =>
      current.includes(lane)
        ? current.length === 1 ? current : current.filter((item) => item !== lane)
        : [...current, lane],
    );
  };

  const toggleBatch = (batchId: string) => {
    setExpandedBatches((current) => {
      const next = new Set(current);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  const copyHash = async (hash: string) => {
    const transaction = (liveData?.transactions ?? []).find((tx) => tx.hash === hash);
    await navigator.clipboard?.writeText(transaction?.fullHash ?? hash.replace("…", ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Crosshair size={21} strokeWidth={2.5} />
          </div>
          <div>
            <strong>CRANKER</strong>
            <span>KEEPER OPS</span>
          </div>
          <button className="mobile-close" onClick={() => setMobileNav(false)} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <nav aria-label="Primary navigation">
          <span className="nav-label">Overview</span>
          <a className="nav-item active" href="#overview">
            <Gauge size={18} /> Command center
          </a>
          <a className="nav-item" href="#transactions">
            <Blocks size={18} /> Transactions
          </a>
          <a className="nav-item" href="#performance">
            <TrendingUp size={18} /> Performance
          </a>

          <span className="nav-label">Operations</span>
          <a className="nav-item" href="#lanes">
            <Layers3 size={18} /> Keeper lanes <em>{laneDefinitions.length}</em>
          </a>
          <a className="nav-item" href="#health">
            <Activity size={18} /> System health
          </a>
        </nav>

        <div className="sidebar-spacer" />
        <div className="signer-card">
          <div className="signer-head">
            <span className="pulse-dot" />
            <strong>
              {liveData
                ? signerHealthy ? "Signer online" : "Signer attention"
                : "Signer status"}
            </strong>
            <span>{liveData ? telemetryError ? "STALE" : "LIVE" : "—"}</span>
          </div>
          <div className="signer-meta">
            <span>Runs</span>
            <strong>{liveData ? `${liveData.execution.activeRuns} active` : "—"}</strong>
          </div>
          <div className="signer-meta">
            <span>Lease</span>
            <strong>{liveData ? `${liveData.execution.signerLeases} held` : "—"}</strong>
          </div>
        </div>
        <div className="network-chip">
          <span className="eth-mark">◆</span>
          Ethereum Mainnet
        </div>
      </aside>

      {mobileNav && <button className="nav-backdrop" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}

      <section className="main-panel">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation">
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <span>Keeper ops</span>
            <i>/</i>
            <strong>Command center</strong>
          </div>
          <div className="topbar-right">
            <div className="sync-state">
              <span className="pulse-dot" />
              {liveData ? telemetryError ? "STALE" : "LIVE" : telemetryError ? "OFFLINE" : "SYNCING"}
              <small>
                {liveData
                  ? `Synced ${new Date(liveData.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : telemetryError ?? "Connecting to telemetry"}
              </small>
            </div>
          </div>
        </header>

        <div className="content" id="overview">
          <section className="hero-row">
            <div>
              <div className="eyebrow">
                <span>ETHEREUM MAINNET</span>
                <i />
                <span>{liveData ? telemetryError ? "STALE TELEMETRY" : "LIVE TELEMETRY" : "READ-ONLY TELEMETRY"}</span>
              </div>
              <h1>Command center</h1>
              <p>Profit, execution quality, and every keeper lane in one view.</p>
            </div>
            <div className="hero-actions">
              <span className="readonly-chip">
                <ShieldCheck size={16} />
                Read-only
              </span>
            </div>
          </section>

          {(telemetryError || !liveData) && (
            <div className={`telemetry-banner ${telemetryError ? "error" : ""}`}>
              <Radio size={15} />
              <span>{telemetryError ? `${telemetryError}${liveData ? "; showing the last successful read." : ""}` : "Waiting for PostgreSQL telemetry…"}</span>
            </div>
          )}

          <section className="metric-grid" aria-label="Key performance metrics">
            <article className="metric-card featured">
              <div className="metric-heading">
                <span>Receipt-attributed P&amp;L</span>
                <div className="metric-icon"><CircleDollarSign size={17} /></div>
              </div>
              <strong className="metric-value">
                {liveData ? formatUsd(liveData.summary.receiptProfitUsd) : "—"}
              </strong>
              <div className="metric-footer">
                <span className={liveData ? "positive" : "muted"}>
                  {liveData && <ArrowUpRight size={14} />}
                  {liveData ? `${liveData.summary.receiptCount} receipts` : "Waiting for telemetry"}
                </span>
                <small>successful receipts</small>
              </div>
            </article>
            <article className="metric-card">
              <div className="metric-heading">
                <span>Receipt net ETH</span>
                <div className="metric-icon"><Wallet size={17} /></div>
              </div>
              <strong className="metric-value">
                {liveData ? <>{liveData.summary.receiptProfitEth.toFixed(5)} <small>ETH</small></> : "—"}
              </strong>
              <div className="metric-footer">
                <span className={liveData ? "positive" : "muted"}>
                  {liveData && <Check size={14} />} {liveData ? "On-chain receipts" : "Waiting for telemetry"}
                </span>
                <small>{liveData ? `@ $${liveData.ethUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "ETH/USD unavailable"}</small>
              </div>
            </article>
            <article className="metric-card">
              <div className="metric-heading">
                <span>Bundle win rate</span>
                <div className="metric-icon"><Target size={17} /></div>
              </div>
              <strong className="metric-value">
                {liveData ? <>{liveData.summary.batchWinRate.toFixed(1)}<small>%</small></> : "—"}
              </strong>
              <div className="metric-footer">
                <span className={liveData ? "positive" : "muted"}>{liveData && <Check size={14} />} {liveData ? `${liveData.summary.batchWins}/${liveData.summary.batchAttempts}` : "Waiting for telemetry"}</span>
                <small>batches won · last 7d</small>
              </div>
            </article>
            <article className="metric-card">
              <div className="metric-heading">
                <span>Relay delivery</span>
                <div className="metric-icon"><Radio size={17} /></div>
              </div>
              <strong className="metric-value">
                {liveData ? <>{liveData.summary.relayDeliveryRate.toFixed(1)} <small>%</small></> : "—"}
              </strong>
              <div className="metric-footer">
                <span className={liveData ? "positive" : "muted"}>{liveData && <Check size={14} />} {liveData ? `${liveData.summary.relayAccepted}/${liveData.summary.relayAttempts}` : "Waiting for telemetry"}</span>
                <small>accepted · last 7d</small>
              </div>
            </article>
          </section>

          <section className="dashboard-grid">
            <article className="panel pnl-panel" id="performance">
              <div className="panel-head">
                <div>
                  <span className="section-kicker">REALIZED PERFORMANCE</span>
                  <h2>Profit over time</h2>
                </div>
                <div className="chart-controls">
                  <div className="view-tabs" aria-label="P&L chart view">
                    <button className={chartMode === "cumulative" ? "selected" : ""} onClick={() => setChartMode("cumulative")}>
                      Cumulative
                    </button>
                    <button className={chartMode === "contribution" ? "selected" : ""} onClick={() => setChartMode("contribution")}>
                      Contribution
                    </button>
                  </div>
                  <div className="range-tabs" aria-label="P&L chart range">
                    {(["24H", "7D", "30D", "ALL"] as Range[]).map((item) => (
                      <button key={item} className={range === item ? "selected" : ""} onClick={() => setRange(item)}>
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="chart-summary">
                <strong>{liveData ? formatUsd(chartData.at(-1)?.activePnl ?? 0) : "—"}</strong>
                <span>{liveData && <ArrowUpRight size={14} />} selected lanes</span>
                <small>
                  {chartMode === "cumulative"
                    ? "Cumulative verified net"
                    : range === "24H"
                      ? "Hourly net contribution"
                      : "Net contribution per period"}
                </small>
              </div>
              <div className="area-chart-wrap" aria-label={`${chartMode} P&L chart for ${range}`}>
                {chartData.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    {chartMode === "cumulative" ? (
                      <AreaChart data={chartData} margin={{ top: 15, right: 4, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#b7f34a" stopOpacity={0.3} />
                            <stop offset="100%" stopColor="#b7f34a" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke="#26302c" strokeDasharray="3 6" />
                        <XAxis dataKey="short" axisLine={false} tickLine={false} tick={{ fill: "#6f7c76", fontSize: 11 }} interval="preserveStartEnd" />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: "#6f7c76", fontSize: 11 }} tickFormatter={(value) => `$${value}`} width={42} />
                        <Tooltip content={<CustomTooltip />} />
                        <Area type="monotone" dataKey="activePnl" name="Selected lanes" stroke="#b7f34a" strokeWidth={2.5} fill="url(#profitFill)" activeDot={{ r: 5, fill: "#101512", stroke: "#b7f34a", strokeWidth: 2 }} />
                      </AreaChart>
                    ) : (
                      <BarChart data={chartData} margin={{ top: 15, right: 4, left: 0, bottom: 0 }} barCategoryGap={range === "24H" ? "12%" : "28%"}>
                        <CartesianGrid vertical={false} stroke="#26302c" strokeDasharray="3 6" />
                        <XAxis dataKey="short" axisLine={false} tickLine={false} tick={{ fill: "#6f7c76", fontSize: 11 }} interval="preserveStartEnd" />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: "#6f7c76", fontSize: 11 }} tickFormatter={(value) => `$${value}`} width={42} />
                        <Tooltip content={<CustomTooltip />} />
                        {laneDefinitions.filter((lane) => activePnlLanes.includes(lane.key)).map((lane) => (
                          <Bar key={lane.key} dataKey={lane.key} name={lane.label} stackId="pnl" fill={lane.color} radius={[2, 2, 0, 0]} />
                        ))}
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                ) : (
                  <div className="data-empty">No receipt P&amp;L in this range.</div>
                )}
              </div>
              <div className="lane-filters" aria-label="Filter P&L by keeper lane">
                {laneDefinitions.map((lane) => {
                  const active = activePnlLanes.includes(lane.key);
                  return (
                    <button
                      key={lane.key}
                      className={active ? "active" : ""}
                      onClick={() => togglePnlLane(lane.key)}
                      title={`${lane.contract} · ${lane.strategy}`}
                    >
                      <i style={{ background: lane.color }} />
                      <span>
                        <strong>{lane.label}</strong>
                        <small>{lane.contract}</small>
                      </span>
                      <Check size={12} />
                    </button>
                  );
                })}
              </div>
            </article>

            <article className="panel lane-panel" id="lanes">
              <div className="panel-head compact">
                <div>
                  <span className="section-kicker">P&amp;L ATTRIBUTION</span>
                  <h2>Profit by lane</h2>
                </div>
              </div>
              <div className="donut-wrap">
                <div className="donut-chart">
                  {liveData ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={displayLaneData} dataKey="chartValue" innerRadius={57} outerRadius={77} paddingAngle={2} stroke="none">
                          {displayLaneData.map((item) => <Cell key={item.name} fill={item.fill} />)}
                        </Pie>
                        <Tooltip content={<CustomTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="data-empty">—</div>
                  )}
                  <div className="donut-center">
                    <strong>{liveData ? displayLaneData.filter((lane) => lane.value !== 0).length : "—"}</strong>
                    <span>lanes</span>
                  </div>
                </div>
                <div className="lane-list">
                  {displayLaneData.map((lane) => (
                    <div className="lane-row" key={lane.name}>
                      <span><i style={{ background: lane.fill }} />{lane.name}</span>
                      <strong>{liveData ? formatUsd(lane.value) : "—"}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="lane-callout">
                <Sparkles size={16} />
                <div>
                  <strong>{!liveData ? "Waiting for telemetry" : leadingLane ? `${leadingLane.name} lead` : "No realized lane profit"}</strong>
                  <span>{liveData ? `${leadingLaneShare.toFixed(1)}% of positive receipt-attributed profit` : "Lane attribution is receipt-based"}</span>
                </div>
              </div>
            </article>
          </section>

          <section className="ops-grid">
            <article className="panel relay-panel">
              <div className="panel-head compact">
                <div>
                  <span className="section-kicker">RELAY INTELLIGENCE</span>
                  <h2>Relay delivery</h2>
                </div>
                <span className="period-label">LAST 7 DAYS</span>
              </div>
              <div className="relay-chart" aria-label="Relay submission performance">
                {displayRelayData.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={displayRelayData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 2 }} barCategoryGap={18}>
                      <XAxis type="number" hide />
                      <YAxis type="category" dataKey="relay" axisLine={false} tickLine={false} tick={{ fill: "#aab5b0", fontSize: 12 }} width={72} />
                      <Tooltip cursor={{ fill: "rgba(255,255,255,.025)" }} content={<CustomTooltip />} />
                      <Bar dataKey="attempted" fill="#26302c" radius={[0, 4, 4, 0]} barSize={9} />
                      <Bar dataKey="landed" radius={[0, 4, 4, 0]} barSize={9}>
                        {displayRelayData.map((item) => <Cell key={item.relay} fill={item.color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="data-empty">No relay submissions in the last 7 days.</div>
                )}
              </div>
              <div className="relay-foot">
                <span><i className="relay-landed" /> Landed</span>
                <span><i className="relay-attempted" /> Attempted</span>
                <strong>{liveData ? `${liveData.summary.relayDeliveryRate.toFixed(1)}% avg.` : "—"}</strong>
              </div>
            </article>

            <article className="panel health-panel" id="health">
              <div className="panel-head compact">
                <div>
                  <span className="section-kicker">SYSTEM PULSE</span>
                  <h2>Execution health</h2>
                </div>
                <div className="health-score"><ShieldCheck size={15} /> {(healthScore * 100).toFixed(0)}%</div>
              </div>
              <div className="health-events">
                {displayHealthEvents.length ? displayHealthEvents.map((event) => (
                    <div className="health-event" key={`${event.time}-${event.title}`}>
                      <span className={`event-dot ${event.tone}`} />
                      <time>{event.time}</time>
                      <div>
                        <strong>{event.title}</strong>
                        <span>{event.meta}</span>
                      </div>
                    </div>
                  )) : <div className="data-empty">Waiting for execution telemetry.</div>}
              </div>
            </article>
          </section>

          <section className="panel tx-panel" id="transactions">
            <div className="tx-header">
              <div>
                <span className="section-kicker">LEDGER</span>
                <h2>Recent transactions</h2>
                <p>Successful receipts and expired one-block bundles.</p>
              </div>
              <div className="tx-tools">
                <div className="search-box">
                  <Search size={15} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search hash, lane, contract…"
                    aria-label="Search transactions"
                  />
                  <span>⌘K</span>
                </div>
                <div className="filter-tabs" aria-label="Transaction status filter">
                  {(["all", "landed", "missed"] as const).map((item) => (
                    <button key={item} className={txFilter === item ? "selected" : ""} onClick={() => setTxFilter(item)}>
                      {item === "all" ? "All" : item === "landed" ? "Landed" : "Missed"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="tx-lane-filters" aria-label="Filter transactions by keeper lane">
              <span>LANE / CONTRACT</span>
              <button className={txLaneFilter === "all" ? "active" : ""} onClick={() => setTxLaneFilter("all")}>
                <Layers3 size={13} /> All execution
              </button>
              {laneDefinitions.map((lane) => (
                <button
                  key={lane.key}
                  className={txLaneFilter === lane.key ? "active" : ""}
                  onClick={() => setTxLaneFilter(lane.key)}
                  title={`${lane.contract} · ${lane.strategy}`}
                >
                  <i style={{ background: lane.color }} />
                  {lane.label}
                  <small>{lane.contract}</small>
                </button>
              ))}
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th>Contract / strategy</th>
                    <th>Block</th>
                    <th>Time</th>
                    <th className="numeric">Gross reward</th>
                    <th className="numeric">Gas + bid</th>
                    <th className="numeric">Net P&amp;L</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row) => {
                    if (row.kind === "transaction") {
                      return (
                        <TransactionTableRow
                          key={row.tx.hash}
                          tx={row.tx}
                          selected={selectedTx?.hash === row.tx.hash}
                          onSelect={setSelectedTx}
                        />
                      );
                    }
                    const expanded = expandedBatches.has(row.id);
                    const reward = row.members.reduce((total, tx) => total + tx.reward, 0);
                    const cost = row.members.reduce((total, tx) => total + tx.cost, 0);
                    const net = row.members.reduce((total, tx) => total + tx.net, 0);
                    const batchLanded = row.members.every((tx) => tx.status === "landed");
                    const first = row.members[0];
                    return (
                      <Fragment key={row.id}>
                        <tr className="batch-summary-row">
                          <td colSpan={2}>
                            <button className="batch-toggle" onClick={() => toggleBatch(row.id)}>
                              <span className={`batch-chevron ${expanded ? "open" : ""}`}><ChevronDown size={15} /></span>
                              <span className="batch-icon"><Layers3 size={15} /></span>
                              <span>
                                <strong>{row.label}</strong>
                                <small>{row.members.length} atomic receipts · {first.lane}</small>
                              </span>
                            </button>
                          </td>
                          <td className="mono">{first.block}</td>
                          <td className="mono">
                            <time className="relative-time" title={`${first.time} MT`}>{first.relative}</time>
                          </td>
                          <td className="numeric mono">{reward ? formatUsd(reward) : "—"}</td>
                          <td className="numeric mono muted">{cost ? `−${formatUsd(cost)}` : "—"}</td>
                          <td className={`numeric mono ${net > 0 ? "profit" : net < 0 ? "loss" : ""}`}>
                            {net > 0 ? `+${formatUsd(net)}` : net < 0 ? `−${formatUsd(Math.abs(net))}` : "—"}
                          </td>
                          <td>
                            <span className={`batch-badge ${batchLanded ? "" : "missed"}`}>
                              {batchLanded ? <Check size={11} /> : <X size={11} />}
                              {batchLanded ? "Batch landed" : "Batch expired"}
                            </span>
                          </td>
                        </tr>
                        {expanded && row.members.map((tx) => (
                          <TransactionTableRow
                            key={tx.hash}
                            tx={tx}
                            nested
                            selected={selectedTx?.hash === tx.hash}
                            onSelect={setSelectedTx}
                          />
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {!filteredTransactions.length && (
                <div className="empty-state">
                  <Search size={22} />
                  <strong>{liveData ? "No matching transactions" : "No telemetry loaded"}</strong>
                  <span>{liveData ? "Try another hash, lane, or status." : telemetryError ?? "Waiting for PostgreSQL telemetry."}</span>
                </div>
              )}
            </div>

            <div className="table-footer">
              <span>{liveData ? `Showing ${tableRows.length} executions · ${filteredTransactions.length} receipt events` : "Ledger data appears when telemetry is available."}</span>
            </div>
          </section>

          <footer>
            <span><Crosshair size={14} /> CRANKER KEEPER OPS</span>
            <p>
              {liveData
                ? "Lane P&L is attributed from successful on-chain receipts."
                : "This dashboard does not display estimates when telemetry is unavailable."}
            </p>
            <span>Block {liveData?.transactions[0]?.block ?? "—"}</span>
          </footer>
        </div>
      </section>

      {selectedTx && (
        <>
          <button className="drawer-backdrop" onClick={() => setSelectedTx(null)} aria-label="Close transaction details" />
          <aside className="tx-drawer" aria-label="Transaction details">
            <div className="drawer-head">
              <div>
                <span className="section-kicker">EXECUTION RECEIPT</span>
                <h2>{selectedTx.lane}</h2>
              </div>
              <button className="ghost-icon" onClick={() => setSelectedTx(null)} aria-label="Close details"><X size={18} /></button>
            </div>
            <div className={`drawer-result ${selectedTx.status}`}>
              {selectedTx.status === "landed" ? <Check size={20} /> : <X size={20} />}
              <div>
                <strong>{selectedTx.status === "landed" ? "Bundle landed" : "Bundle expired safely"}</strong>
                <span>{selectedTx.status === "landed" ? "Included through private submission" : "No gas spent · private submission"}</span>
              </div>
              {selectedTx.net > 0 && <b>+{formatUsd(selectedTx.net)}</b>}
            </div>
            <div className="drawer-section">
              <span className="drawer-label">Transaction hash</span>
              <button className="hash-copy" onClick={() => copyHash(selectedTx.hash)}>
                {selectedTx.hash}
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
            <div className="drawer-grid">
              <div><span>Target block</span><strong>{selectedTx.block}</strong></div>
              <div><span>Timestamp</span><strong>{selectedTx.time}</strong></div>
              <div><span>Effective bid</span><strong>{selectedTx.bid}</strong></div>
              <div><span>Gas used</span><strong>{selectedTx.gas}</strong></div>
            </div>
            <div className="drawer-section">
              <span className="drawer-label">Atomic call sequence</span>
              <div className="call-stack">
                {selectedTx.calls.map((call, index) => (
                  <div key={call}>
                    <span>{index + 1}</span>
                    <strong>{call}()</strong>
                    {index < selectedTx.calls.length - 1 && <i />}
                  </div>
                ))}
              </div>
            </div>
            <div className="economics-card">
              <div><span>Gross reward</span><strong>{selectedTx.reward ? formatUsd(selectedTx.reward) : "$0.00"}</strong></div>
              <div><span>Gas + bid</span><strong>−{formatUsd(selectedTx.cost)}</strong></div>
              <div className="economics-total"><span>Realized net</span><strong>{selectedTx.net ? `+${formatUsd(selectedTx.net)}` : "$0.00"}</strong></div>
            </div>
            {selectedTx.fullHash && (
              <a
                className="etherscan-button"
                href={`https://etherscan.io/tx/${selectedTx.fullHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Etherscan <ExternalLink size={15} />
              </a>
            )}
          </aside>
        </>
      )}
    </main>
  );
}
