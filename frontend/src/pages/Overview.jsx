import { Activity, CircleCheck, Clock3, CreditCard, Plus, RotateCw, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useResource } from '../api.js';
import { useSession } from '../session.js';
import { Badge, Button, Empty, FilterFields, PageTitle, Panel, PaymentRows, Result, Table, filterQuery,
  money, number, rate } from '../components/shared.jsx';

function Metric({ title, value, detail, Icon, color = 'blue' }) {
  return <section className="metric"><div className="metric-head"><span>{title}</span><i className={'metric-icon ' + color}><Icon size={17} /></i></div>
    <div className="metric-value">{value}</div><p>{detail}</p></section>;
}

function Metrics({ data }) {
  const volume = data.volume.map(item => money(item.amountMinor, item.currency));
  return <div className="metric-grid">
    <Metric title="Payment volume" value={volume[0] || '—'} detail={volume.length > 1 ? volume.slice(1).join(' · ') : 'Across the selected period'} Icon={Wallet} />
    <Metric title="Transactions" value={number(data.total)} detail={`${number(data.failed)} failed · ${number(data.pending)} open`} Icon={CreditCard} />
    <Metric title="Success rate" value={rate(data.successRate)} detail={`${number(data.successful)} successful payments`} Icon={CircleCheck} color="green" />
    <Metric title="Avg. response time" value={data.averageResponseTimeMs == null ? '—' : `${number(data.averageResponseTimeMs)} ms`} detail="Across recorded attempts" Icon={Clock3} color="amber" />
  </div>;
}

function Trend({ data }) {
  if (!data.some(point => point.total)) return <Empty>No payment activity in this period.</Empty>;
  return <div className="chart" aria-label="Payments by date">
    <ResponsiveContainer width="100%" height={245}>
      <AreaChart data={data} margin={{ top: 12, left: -18, right: 12, bottom: 6 }}>
        <defs><linearGradient id="activity-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#376cc3" stopOpacity={0.20} /><stop offset="100%" stopColor="#376cc3" stopOpacity={0.02} />
        </linearGradient></defs>
        <CartesianGrid vertical={false} stroke="#e8edf3" strokeDasharray="4 4" />
        <XAxis dataKey="date" tickFormatter={date => date.slice(5)} tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} minTickGap={18} />
        <YAxis allowDecimals={false} tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
        <Tooltip formatter={value => [value, 'Transactions']} />
        <Area type="monotone" dataKey="total" stroke="#2457a6" strokeWidth={2.5} fill="url(#activity-fill)" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}

function GatewayStatus({ data }) {
  if (!data.length) return <Empty>No gateways configured.</Empty>;
  return <ul className="gateway-list">{data.map(gateway => <li key={gateway.id}>
    <span className="gateway-icon"><Activity size={17} /></span><div><strong>{gateway.name}</strong>
      <small>{gateway.total ? `${number(gateway.total)} attempts · ${rate(gateway.successRate)} success` : 'No recorded attempts'}</small></div>
    <Badge value={gateway.active ? gateway.health : 'INACTIVE'} /></li>)}</ul>;
}

export function Overview() {
  const { user } = useSession();
  const admin = user.role === 'ADMIN';
  const root = admin ? '/admin/analytics' : '/analytics';
  const summary = useResource(root + '/overview', undefined, 10000);
  const trend = useResource(root + '/transactions', undefined, 10000);
  const gateways = useResource(root + '/gateways', undefined, 10000);
  const recent = useResource(admin ? null : '/payments', { limit: 5 }, 7000);
  return <>
    <PageTitle title="Overview" description={admin ? 'Monitor payment activity across the platform.' : 'Monitor payments and gateway health across your workspace.'}
      action={admin ? <Button kind="secondary" onClick={() => { summary.reload(); trend.reload(); gateways.reload(); }}><RotateCw size={16} /> Refresh</Button>
        : <Link className="button primary" to="/transactions?new=1"><Plus size={17} /> New payment</Link>} />
    <Result resource={summary}>{data => <Metrics data={data} />}</Result>
    <div className="overview-grid">
      <Panel title="Transaction activity" subtitle="Daily payments over the last 14 days"><Result resource={trend}>{data => <Trend data={data} />}</Result></Panel>
      <Panel title="Gateway status" subtitle="Availability and observed performance"><Result resource={gateways}>{data => <GatewayStatus data={data} />}</Result></Panel>
    </div>
    {!admin && <Panel title="Recent transactions" subtitle="Latest payments in your workspace" action={<Link className="button secondary" to="/transactions">View all</Link>}>
      <Result resource={recent}>{data => <PaymentRows items={data.items} empty="No payments yet. Create a simulated payment to see it here." />}</Result>
    </Panel>}
  </>;
}

export function Analytics() {
  const { user } = useSession();
  const root = user.role === 'ADMIN' ? '/admin/analytics' : '/analytics';
  const [filters, setFilters] = useState({});
  const params = filterQuery(filters);
  const summary = useResource(root + '/overview', params);
  const trend = useResource(root + '/transactions', params);
  const gateway = useResource(root + '/gateways', params);
  return <>
    <PageTitle title="Analytics" description="Measure payment outcomes and compare gateway performance." />
    <Panel><div className="filter-grid"><FilterFields filters={filters}
      update={(name, value) => setFilters(previous => ({ ...previous, [name]: value }))} /></div></Panel>
    <Result resource={summary}>{data => <Metrics data={data} />}</Result>
    <Panel title="Transaction activity" subtitle="Daily counts for up to the last 31 days of the selected range">
      <Result resource={trend}>{data => <Trend data={data} />}</Result>
    </Panel>
    <Panel title="Gateway performance"><Result resource={gateway}>{data => data.length ? <Table headers={['Gateway', 'Health', 'Attempts', 'Success rate', 'Avg. response']}>
      {data.map(item => <tr key={item.id}><td className="strong">{item.name}</td><td><Badge value={item.active ? item.health : 'INACTIVE'} /></td>
        <td>{number(item.total)}</td><td>{rate(item.successRate)}</td><td>{item.averageResponseTimeMs == null ? '—' : item.averageResponseTimeMs + ' ms'}</td></tr>)}</Table>
      : <Empty>No gateway activity.</Empty>}</Result></Panel>
  </>;
}
