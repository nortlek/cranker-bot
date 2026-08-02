"use client";

import {
  Activity,
  ArrowUpRight,
  Blocks,
  Bot,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Copy,
  Crosshair,
  ExternalLink,
  Gauge,
  Inbox,
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
  Zap,
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
type LaneKey = "orders" | "lifecycle" | "fwa" | "pull" | "other";
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
  builder: string;
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
  { key: "other", label: "Other lanes", contract: "Convex / Liquity", strategy: "harvest + liquidation", color: "#ffb35c" },
];

const basePnlData = [
  { label: "Jul 02", short: "02", pnl: 3.2, revenue: 7.1, cost: 3.9 },
  { label: "Jul 04", short: "04", pnl: 8.9, revenue: 14.8, cost: 5.9 },
  { label: "Jul 06", short: "06", pnl: 16.4, revenue: 25.2, cost: 8.8 },
  { label: "Jul 08", short: "08", pnl: 28.6, revenue: 39.4, cost: 10.8 },
  { label: "Jul 10", short: "10", pnl: 41.1, revenue: 56.5, cost: 15.4 },
  { label: "Jul 12", short: "12", pnl: 52.8, revenue: 72.9, cost: 20.1 },
  { label: "Jul 14", short: "14", pnl: 69.5, revenue: 95.1, cost: 25.6 },
  { label: "Jul 16", short: "16", pnl: 82.2, revenue: 114.6, cost: 32.4 },
  { label: "Jul 18", short: "18", pnl: 103.8, revenue: 141.3, cost: 37.5 },
  { label: "Jul 20", short: "20", pnl: 122.4, revenue: 168.9, cost: 46.5 },
  { label: "Jul 22", short: "22", pnl: 137.1, revenue: 190.4, cost: 53.3 },
  { label: "Jul 24", short: "24", pnl: 164.6, revenue: 222.8, cost: 58.2 },
  { label: "Jul 26", short: "26", pnl: 189.3, revenue: 258.5, cost: 69.2 },
  { label: "Jul 27", short: "27", pnl: 202.1, revenue: 277.7, cost: 75.6 },
  { label: "Jul 28 06:00", short: "06:00", pnl: 211.8, revenue: 291.2, cost: 79.4 },
  { label: "Jul 28 12:00", short: "12:00", pnl: 218.9, revenue: 301.7, cost: 82.8 },
  { label: "Jul 28 18:00", short: "18:00", pnl: 226.5, revenue: 313.2, cost: 86.7 },
  { label: "Jul 29 06:00", short: "06:00", pnl: 237.2, revenue: 327.9, cost: 90.7 },
  { label: "Jul 29 18:00", short: "18:00", pnl: 245.8, revenue: 340.1, cost: 94.3 },
  { label: "Jul 30 08:00", short: "08:00", pnl: 253.74, revenue: 351.64, cost: 97.9 },
];

const contributionMixes = [
  [0.66, 0.15, 0.08, 0.08, 0.03],
  [0.48, 0.28, 0.13, 0.07, 0.04],
  [0.55, 0.16, 0.2, 0.05, 0.04],
  [0.41, 0.36, 0.11, 0.08, 0.04],
  [0.52, 0.19, 0.18, 0.07, 0.04],
];

const pnlData: PnlPoint[] = basePnlData.map((point, index) => {
  const previous = index === 0 ? 0 : basePnlData[index - 1].pnl;
  const delta = point.pnl - previous;
  const mix = contributionMixes[index % contributionMixes.length];
  return {
    ...point,
    orders: Number((delta * mix[0]).toFixed(2)),
    lifecycle: Number((delta * mix[1]).toFixed(2)),
    fwa: Number((delta * mix[2]).toFixed(2)),
    pull: Number((delta * mix[3]).toFixed(2)),
    other: Number((delta * mix[4]).toFixed(2)),
  };
});

const laneData = [
  { key: "orders" as const, name: "Standing orders", short: "Orders", value: 128.42, chartValue: 128.42, fill: "#b7f34a" },
  { key: "lifecycle" as const, name: "Pool lifecycle", short: "Lifecycle", value: 67.18, chartValue: 67.18, fill: "#6ce5d7" },
  { key: "fwa" as const, name: "FWA backruns", short: "FWA", value: 41.63, chartValue: 41.63, fill: "#8ba6ff" },
  { key: "pull" as const, name: "Pool pull", short: "Pull", value: 12.84, chartValue: 12.84, fill: "#c5a7ff" },
  { key: "other" as const, name: "Other lanes", short: "Other", value: 3.67, chartValue: 3.67, fill: "#65706a" },
];

const transactions: Transaction[] = [
  {
    hash: "0xe05f…8b7a",
    laneKey: "fwa",
    lane: "FWA backrun",
    contract: "FWA",
    strategy: "processAcquisitions",
    accent: "#8ba6ff",
    time: "Jul 30, 08:42:17",
    relative: "2m ago",
    block: "24,092,314",
    builder: "Titan",
    reward: 0,
    cost: 0.52,
    net: -0.52,
    status: "landed",
    calls: ["processAcquisitions"],
    gas: "1,184,230",
    bid: "3.00%",
    batchId: "fwa-372",
    batchLabel: "FWA round 372",
    batchIndex: 1,
    batchSize: 3,
  },
  {
    hash: "0x740a…19e4",
    laneKey: "fwa",
    lane: "FWA backrun",
    contract: "PullPool",
    strategy: "syncFwaResult",
    accent: "#8ba6ff",
    time: "Jul 30, 08:42:17",
    relative: "2m ago",
    block: "24,092,314",
    builder: "Titan",
    reward: 0,
    cost: 0.21,
    net: -0.21,
    status: "landed",
    calls: ["syncFwaResult"],
    gas: "246,180",
    bid: "3.00%",
    batchId: "fwa-372",
    batchLabel: "FWA round 372",
    batchIndex: 2,
    batchSize: 3,
  },
  {
    hash: "0x92c8…fa11",
    laneKey: "fwa",
    lane: "FWA backrun",
    contract: "PullPool",
    strategy: "settle",
    accent: "#8ba6ff",
    time: "Jul 30, 08:42:17",
    relative: "2m ago",
    block: "24,092,314",
    builder: "Titan",
    reward: 18.62,
    cost: 4.51,
    net: 14.11,
    status: "landed",
    calls: ["settle"],
    gas: "419,306",
    bid: "3.00%",
    batchId: "fwa-372",
    batchLabel: "FWA round 372",
    batchIndex: 3,
    batchSize: 3,
  },
  {
    hash: "0x19bd…4cf2",
    laneKey: "orders",
    lane: "Standing order",
    contract: "PullStandingOrder",
    strategy: "crank",
    accent: "#b7f34a",
    time: "Jul 30, 08:26:02",
    relative: "18m ago",
    block: "24,092,236",
    builder: "Beaver",
    reward: 9.84,
    cost: 3.17,
    net: 6.67,
    status: "landed",
    calls: ["crank", "coinbasePayment"],
    gas: "418,772",
    bid: "72.20%",
  },
  {
    hash: "0x61cc…dda8",
    laneKey: "lifecycle",
    lane: "Pool lifecycle",
    contract: "FWA",
    strategy: "processAcquisitions",
    accent: "#6ce5d7",
    time: "Jul 30, 08:01:45",
    relative: "42m ago",
    block: "24,092,109",
    builder: "Flashbots",
    reward: 0,
    cost: 1.02,
    net: -1.02,
    status: "landed",
    calls: ["processAcquisitions"],
    gas: "926,188",
    bid: "3.00%",
    batchId: "pool-371",
    batchLabel: "Lifecycle round 371",
    batchIndex: 1,
    batchSize: 3,
  },
  {
    hash: "0x7f30…aae4",
    laneKey: "lifecycle",
    lane: "Pool lifecycle",
    contract: "PullPool",
    strategy: "syncFwaResult",
    accent: "#6ce5d7",
    time: "Jul 30, 08:01:45",
    relative: "42m ago",
    block: "24,092,109",
    builder: "Flashbots",
    reward: 0,
    cost: 0.68,
    net: -0.68,
    status: "landed",
    calls: ["syncFwaResult"],
    gas: "189,461",
    bid: "3.00%",
    batchId: "pool-371",
    batchLabel: "Lifecycle round 371",
    batchIndex: 2,
    batchSize: 3,
  },
  {
    hash: "0xfcc1…107d",
    laneKey: "lifecycle",
    lane: "Pool lifecycle",
    contract: "PullPool",
    strategy: "settle",
    accent: "#6ce5d7",
    time: "Jul 30, 08:01:45",
    relative: "42m ago",
    block: "24,092,109",
    builder: "Flashbots",
    reward: 12.27,
    cost: 2.92,
    net: 9.35,
    status: "landed",
    calls: ["settle"],
    gas: "511,087",
    bid: "3.00%",
    batchId: "pool-371",
    batchLabel: "Lifecycle round 371",
    batchIndex: 3,
    batchSize: 3,
  },
  {
    hash: "0xb541…3ae0",
    laneKey: "pull",
    lane: "Pool pull",
    contract: "PullPool",
    strategy: "pending final-ticket backrun",
    accent: "#c5a7ff",
    time: "Jul 30, 07:49:03",
    relative: "55m ago",
    block: "24,092,045",
    builder: "—",
    reward: 0,
    cost: 0,
    net: 0,
    status: "missed",
    calls: ["buyTickets", "pull"],
    gas: "—",
    bid: "10.00%",
  },
  {
    hash: "0xa90f…f5c1",
    laneKey: "orders",
    lane: "Standing order",
    contract: "PullStandingOrder",
    strategy: "crank",
    accent: "#b7f34a",
    time: "Jul 30, 07:31:39",
    relative: "1h ago",
    block: "24,091,956",
    builder: "Titan",
    reward: 6.43,
    cost: 2.14,
    net: 4.29,
    status: "landed",
    calls: ["crank"],
    gas: "287,442",
    bid: "68.54%",
  },
  {
    hash: "0x873d…91bf",
    laneKey: "other",
    lane: "Convex earmark",
    contract: "Booster",
    strategy: "earmarkRewards",
    accent: "#ffb35c",
    time: "Jul 30, 06:58:14",
    relative: "2h ago",
    block: "24,091,786",
    builder: "Quasar",
    reward: 5.76,
    cost: 3.21,
    net: 2.55,
    status: "landed",
    calls: ["earmarkRewards"],
    gas: "689,121",
    bid: "10.00%",
  },
  {
    hash: "0x3de7…076c",
    laneKey: "orders",
    lane: "Standing order",
    contract: "PullVault",
    strategy: "crank",
    accent: "#b7f34a",
    time: "Jul 30, 06:44:51",
    relative: "2h ago",
    block: "24,091,718",
    builder: "Titan",
    reward: 4.11,
    cost: 1.48,
    net: 2.63,
    status: "landed",
    calls: ["crank"],
    gas: "231,099",
    bid: "64.80%",
  },
  {
    hash: "0x04aa…3d82",
    laneKey: "lifecycle",
    lane: "Pool lifecycle",
    contract: "PullPool",
    strategy: "sync → settle",
    accent: "#6ce5d7",
    time: "Jul 30, 06:11:22",
    relative: "3h ago",
    block: "24,091,547",
    builder: "—",
    reward: 0,
    cost: 0,
    net: 0,
    status: "missed",
    calls: ["syncFwaResult", "settle"],
    gas: "—",
    bid: "72.50%",
  },
];

const builderData = [
  { builder: "Titan", landed: 41, attempted: 48, color: "#b7f34a" },
  { builder: "Flashbots", landed: 27, attempted: 35, color: "#6ce5d7" },
  { builder: "Beaver", landed: 18, attempted: 24, color: "#8ba6ff" },
  { builder: "Quasar", landed: 11, attempted: 17, color: "#c5a7ff" },
];

const healthEvents = [
  { time: "08:44:02", title: "Pass complete", meta: "block 24,092,323 · 286ms", tone: "good" },
  { time: "08:43:50", title: "New head received", meta: "WebSocket · 61ms", tone: "good" },
  { time: "08:42:29", title: "Receipts reconciled", meta: "+0.006958 ETH net", tone: "good" },
  { time: "08:42:17", title: "Bundle included", meta: "Titan · target 24,092,314", tone: "accent" },
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
          <small>{nested ? `receipt ${tx.batchIndex} of ${tx.batchSize}` : tx.relative}</small>
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
      <td>{tx.builder}</td>
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
  const [range, setRange] = useState<Range>("30D");
  const [chartMode, setChartMode] = useState<"cumulative" | "contribution">("cumulative");
  const [activePnlLanes, setActivePnlLanes] = useState<LaneKey[]>(laneDefinitions.map((lane) => lane.key));
  const [txFilter, setTxFilter] = useState<"all" | TxStatus>("all");
  const [txLaneFilter, setTxLaneFilter] = useState<"all" | LaneKey>("all");
  const [query, setQuery] = useState("");
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set(["fwa-372"]));

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/dashboard", {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as DashboardApiResponse;
        if (!cancelled) setLiveData(data);
      } catch {
        // The clearly labeled layout snapshot remains visible while telemetry is unavailable.
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
    const source = liveData?.pnl.length ? liveData.pnl : pnlData;
    const ranged = range === "24H" ? source.slice(-2) : range === "7D" ? source.slice(-7) : source;
    return ranged.reduce<Array<PnlPoint & { activePnl: number }>>((points, point) => {
      const interval = activePnlLanes.reduce((total, lane) => total + point[lane], 0);
      const cumulative = (points.at(-1)?.activePnl ?? 0) + interval;
      points.push({ ...point, activePnl: Number(cumulative.toFixed(2)) });
      return points;
    }, []);
  }, [activePnlLanes, liveData, range]);

  const filteredTransactions = useMemo(() => {
    const source = liveData === null ? transactions : liveData.transactions;
    return source.filter((tx) => {
      const statusMatch = txFilter === "all" || tx.status === txFilter;
      const laneMatch = txLaneFilter === "all" || tx.laneKey === txLaneFilter;
      const queryMatch = `${tx.hash} ${tx.fullHash ?? ""} ${tx.lane} ${tx.contract} ${tx.strategy} ${tx.builder} ${tx.block}`
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
    if (!liveData) return laneData;
    return laneDefinitions.map((lane) => {
      const telemetry = liveData.lanes.find((item) => item.key === lane.key);
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
  const leadingLane = [...displayLaneData].sort(
    (left, right) => right.value - left.value,
  )[0];
  const leadingLaneShare =
    leadingLane && profitableLaneTotal > 0
      ? (Math.max(0, leadingLane.value) / profitableLaneTotal) * 100
      : 0;

  const displayRelayData = liveData
    ? liveData.relays.map((relay, index) => ({
        builder: `Relay ${relay.relayIndex + 1}`,
        attempted: relay.attempted,
        landed: relay.accepted,
        color: laneDefinitions[index % laneDefinitions.length].color,
      }))
    : builderData;

  const lastPassFresh = liveData?.execution.lastPassAt
    ? Date.parse(liveData.generatedAt) - Date.parse(liveData.execution.lastPassAt) < 60_000
    : false;
  const signerHealthy = Boolean(
    liveData &&
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
    : 1;

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
    : healthEvents;

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
    const transaction = (liveData?.transactions ?? transactions).find((tx) => tx.hash === hash);
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
            <Gauge size={18} /> Command center <span>⌘1</span>
          </a>
          <a className="nav-item" href="#transactions">
            <Blocks size={18} /> Transactions <span>⌘2</span>
          </a>
          <a className="nav-item" href="#performance">
            <TrendingUp size={18} /> Performance <span>⌘3</span>
          </a>

          <span className="nav-label">Operations</span>
          <a className="nav-item" href="#lanes">
            <Layers3 size={18} /> Keeper lanes <em>{laneDefinitions.length}</em>
          </a>
          <a className="nav-item" href="#health">
            <Activity size={18} /> System health <i />
          </a>
          <a className="nav-item" href="#radar">
            <Radio size={18} /> Opportunity radar <em>3</em>
          </a>
        </nav>

        <div className="sidebar-spacer" />
        <div className="signer-card">
          <div className="signer-head">
            <span className="pulse-dot" />
            <strong>
              {liveData
                ? signerHealthy ? "Signer online" : "Signer attention"
                : "Signer snapshot"}
            </strong>
            <span>PROD</span>
          </div>
          <div className="signer-address">0xeAaf…2D48</div>
          <div className="signer-meta">
            <span>Runs</span>
            <strong>{liveData ? `${liveData.execution.activeRuns} active` : "1 active"}</strong>
          </div>
          <div className="signer-meta">
            <span>Lease</span>
            <strong>{liveData ? `${liveData.execution.signerLeases} held` : "Acquired"}</strong>
          </div>
        </div>
        <div className="network-chip">
          <span className="eth-mark">◆</span>
          Ethereum Mainnet
          <ChevronDown size={14} />
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
              {liveData ? "LIVE" : "DEMO"}
              <small>
                {liveData
                  ? `Synced ${new Date(liveData.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                  : "Connecting to telemetry"}
              </small>
            </div>
            <button className="icon-button" aria-label="Open activity inbox">
              <Inbox size={18} />
              <span className="notification-dot" />
            </button>
            <div className="avatar">KT</div>
          </div>
        </header>

        <div className="content" id="overview">
          <section className="hero-row">
            <div>
              <div className="eyebrow">
                <span>ETHEREUM MAINNET</span>
                <i />
                <span>{liveData ? "LIVE TELEMETRY" : "LAYOUT SNAPSHOT"}</span>
              </div>
              <h1>Command center</h1>
              <p>Profit, execution quality, and every keeper lane in one view.</p>
            </div>
            <div className="hero-actions">
              <button className="secondary-button">
                <Clock3 size={16} />
                {liveData
                  ? new Date(liveData.generatedAt).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "Jul 30, 2026"}
                <ChevronDown size={14} />
              </button>
              <button className="primary-button" disabled title="Execution remains isolated from the dashboard">
                <ShieldCheck size={16} />
                Read-only
              </button>
            </div>
          </section>

          <section className="metric-grid" aria-label="Key performance metrics">
            <article className="metric-card featured">
              <div className="metric-heading">
                <span>{liveData ? "Receipt-attributed P&L" : "Illustrative P&L"}</span>
                <div className="metric-icon"><CircleDollarSign size={17} /></div>
              </div>
              <strong className="metric-value">
                {formatUsd(liveData?.summary.receiptProfitUsd ?? 253.74)}
              </strong>
              <div className="metric-footer">
                <span className="positive">
                  <ArrowUpRight size={14} />
                  {liveData ? `${liveData.summary.receiptCount} receipts` : "$36.82"}
                </span>
                <small>{liveData ? "successful receipts" : "last 24 hours"}</small>
              </div>
              <div className="micro-chart" aria-hidden="true">
                {[22, 30, 27, 39, 35, 46, 50, 48, 63, 69, 76, 89].map((height, index) => (
                  <i key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
            </article>
            <article className="metric-card">
              <div className="metric-heading">
                <span>{liveData ? "Receipt net ETH" : "Net ETH equivalent"}</span>
                <div className="metric-icon"><Wallet size={17} /></div>
              </div>
              <strong className="metric-value">
                {(liveData?.summary.receiptProfitEth ?? 0.13194).toFixed(5)} <small>ETH</small>
              </strong>
              <div className="metric-footer">
                <span className="positive">
                  <Check size={14} /> {liveData ? "On-chain receipts" : "Reconciled"}
                </span>
                <small>@ ${(liveData?.ethUsd ?? 1_923.19).toLocaleString("en-US", { minimumFractionDigits: 2 })}</small>
              </div>
            </article>
            <article className="metric-card">
              <div className="metric-heading">
                <span>Bundle win rate</span>
                <div className="metric-icon"><Target size={17} /></div>
              </div>
              <strong className="metric-value">
                {(liveData?.summary.batchWinRate ?? 74.2).toFixed(1)}<small>%</small>
              </strong>
              <div className="metric-footer">
                <span className="positive"><Check size={14} /> {liveData ? `${liveData.summary.batchWins}/${liveData.summary.batchAttempts}` : "5.8 pts"}</span>
                <small>{liveData ? "batches won · last 7d" : "vs previous 7d"}</small>
              </div>
            </article>
            <article className="metric-card">
              <div className="metric-heading">
                <span>{liveData ? "Relay delivery" : "Median inclusion"}</span>
                <div className="metric-icon"><Radio size={17} /></div>
              </div>
              <strong className="metric-value">
                {liveData ? liveData.summary.relayDeliveryRate.toFixed(1) : "1.0"} <small>{liveData ? "%" : "block"}</small>
              </strong>
              <div className="metric-footer">
                <span className="positive"><Check size={14} /> {liveData ? `${liveData.summary.relayAccepted}/${liveData.summary.relayAttempts}` : "340ms"}</span>
                <small>{liveData ? "accepted · last 7d" : "planning latency"}</small>
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
                <strong>{formatUsd(chartData.at(-1)?.activePnl ?? 0)}</strong>
                <span><ArrowUpRight size={14} /> selected lanes</span>
                <small>{chartMode === "cumulative" ? "Cumulative verified net" : "Net contribution per period"}</small>
              </div>
              <div className="area-chart-wrap" aria-label={`Cumulative P&L chart for ${range}`}>
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
                    <BarChart data={chartData} margin={{ top: 15, right: 4, left: 0, bottom: 0 }} barCategoryGap="28%">
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
                <button className="ghost-icon" aria-label="Open lane analytics"><ExternalLink size={16} /></button>
              </div>
              <div className="donut-wrap">
                <div className="donut-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={displayLaneData} dataKey="chartValue" innerRadius={57} outerRadius={77} paddingAngle={2} stroke="none">
                        {displayLaneData.map((item) => <Cell key={item.name} fill={item.fill} />)}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="donut-center">
                    <strong>{displayLaneData.filter((lane) => lane.value !== 0).length}</strong>
                    <span>lanes</span>
                  </div>
                </div>
                <div className="lane-list">
                  {displayLaneData.map((lane) => (
                    <div className="lane-row" key={lane.name}>
                      <span><i style={{ background: lane.fill }} />{lane.name}</span>
                      <strong>{formatUsd(lane.value)}</strong>
                    </div>
                  ))}
                </div>
              </div>
              <div className="lane-callout">
                <Sparkles size={16} />
                <div>
                  <strong>{leadingLane ? `${leadingLane.name} lead` : "No realized lane profit"}</strong>
                  <span>{leadingLaneShare.toFixed(1)}% of positive receipt-attributed profit</span>
                </div>
              </div>
            </article>
          </section>

          <section className="ops-grid">
            <article className="panel builder-panel">
              <div className="panel-head compact">
                <div>
                  <span className="section-kicker">RELAY INTELLIGENCE</span>
                  <h2>{liveData ? "Relay delivery" : "Builder inclusion"}</h2>
                </div>
                <span className="period-label">LAST 7 DAYS</span>
              </div>
              <div className="builder-chart" aria-label="Builder inclusion performance">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={displayRelayData} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 2 }} barCategoryGap={18}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="builder" axisLine={false} tickLine={false} tick={{ fill: "#aab5b0", fontSize: 12 }} width={72} />
                    <Tooltip cursor={{ fill: "rgba(255,255,255,.025)" }} content={<CustomTooltip />} />
                    <Bar dataKey="attempted" fill="#26302c" radius={[0, 4, 4, 0]} barSize={9} />
                    <Bar dataKey="landed" radius={[0, 4, 4, 0]} barSize={9}>
                      {displayRelayData.map((item) => <Cell key={item.builder} fill={item.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="builder-foot">
                <span><i className="built-landed" /> Landed</span>
                <span><i className="built-attempted" /> Attempted</span>
                <strong>{liveData ? liveData.summary.relayDeliveryRate.toFixed(1) : "77.4"}% avg.</strong>
              </div>
            </article>

            <article className="panel radar-panel" id="radar">
              <div className="panel-head compact">
                <div>
                  <span className="section-kicker">LIVE OPPORTUNITIES</span>
                  <h2>Alpha radar</h2>
                </div>
                <span className="radar-status"><span className="pulse-dot" /> SCANNING</span>
              </div>
              <div className="radar-list">
                {liveData ? (
                  <>
                    <div className={`radar-item ${liveData.execution.viable > 0 ? "hot" : ""}`}>
                      <div className="radar-icon"><Zap size={17} /></div>
                      <div>
                        <strong>Latest planner result</strong>
                        <span>Block {liveData.execution.lastBlock || "—"}</span>
                      </div>
                      <div className="radar-value">
                        <strong>{liveData.execution.viable}</strong>
                        <span>viable</span>
                      </div>
                    </div>
                    <div className="radar-item">
                      <div className="radar-icon"><Bot size={17} /></div>
                      <div>
                        <strong>Private relay delivery</strong>
                        <span>{liveData.summary.relayAttempts} attempts · last 7d</span>
                      </div>
                      <div className="radar-value">
                        <strong>{liveData.summary.relayDeliveryRate.toFixed(1)}%</strong>
                        <span>accepted</span>
                      </div>
                    </div>
                    <div className="radar-item">
                      <div className="radar-icon"><Layers3 size={17} /></div>
                      <div>
                        <strong>Latest execution</strong>
                        <span>{liveData.transactions[0]?.lane ?? "No recent transaction"}</span>
                      </div>
                      <div className="radar-value">
                        <strong>{liveData.transactions[0]?.relative ?? "—"}</strong>
                        <span>{liveData.transactions[0]?.status ?? "idle"}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="radar-item hot">
                      <div className="radar-icon"><Zap size={17} /></div>
                      <div><strong>Snapshot example</strong><span>Waiting for live telemetry</span></div>
                      <div className="radar-value"><strong>—</strong><span>offline</span></div>
                    </div>
                  </>
                )}
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
                {displayHealthEvents.map((event) => (
                  <div className="health-event" key={`${event.time}-${event.title}`}>
                    <span className={`event-dot ${event.tone}`} />
                    <time>{event.time}</time>
                    <div>
                      <strong>{event.title}</strong>
                      <span>{event.meta}</span>
                    </div>
                  </div>
                ))}
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
                    placeholder="Search hash, lane, builder…"
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
                    <th>Builder</th>
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
                          <td>{first.builder}</td>
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
                  <strong>No matching transactions</strong>
                  <span>Try another hash, lane, or status.</span>
                </div>
              )}
            </div>

            <div className="table-footer">
              <span>Showing {tableRows.length} executions · {filteredTransactions.length} receipt events</span>
              <button>View full ledger <ArrowUpRight size={14} /></button>
            </div>
          </section>

          <footer>
            <span><Crosshair size={14} /> CRANKER KEEPER OPS</span>
            <p>
              {liveData
                ? "Lane P&L is attributed from successful on-chain receipts."
                : "Telemetry unavailable; illustrative layout data is shown."}
            </p>
            <span>Block {liveData?.transactions[0]?.block ?? "24,092,323"}</span>
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
                <span>{selectedTx.status === "landed" ? `Included by ${selectedTx.builder}` : "No gas spent · private submission"}</span>
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
              <div><span>Builder bid</span><strong>{selectedTx.bid}</strong></div>
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
              <div><span>Gas + builder</span><strong>−{formatUsd(selectedTx.cost)}</strong></div>
              <div className="economics-total"><span>Realized net</span><strong>{selectedTx.net ? `+${formatUsd(selectedTx.net)}` : "$0.00"}</strong></div>
            </div>
            <button className="etherscan-button">
              View on Etherscan <ExternalLink size={15} />
            </button>
          </aside>
        </>
      )}
    </main>
  );
}
