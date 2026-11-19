import { Activity, CalendarDays, FlaskConical, RadioTower, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../session.js';
import { invalid, send, useAction, useResource } from '../api.js';
import {
  Badge, Button, Empty, Field, Notice, PageTitle, Pager, Panel, Result, Table, dateTime, dateWindow, gatewayNames,
  human, isoDate, methods, money, number, rate, toMinor,
} from '../components/shared.jsx';
import { Decision } from './Transactions.jsx';

function GatewayCard({ gateway, reload }) {
  const action = useAction();
  const [profileOpen, setProfileOpen] = useState(false);
  const health = useResource(profileOpen ? '/gateways/' + gateway.id + '/health' : null);
  async function update(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await action.run(() => send('patch', '/gateways/' + gateway.id, {
      active: form.get('active') === 'on', priority: Number(form.get('priority')),
    }), 'Gateway configuration saved.');
    if (result) { health.reload(); reload(); }
  }
  return <Panel title={gateway.name} subtitle={gateway.code} action={<Badge value={gateway.active && gateway.systemActive ? gateway.health : 'INACTIVE'} />}>
    <form className="panel-body stack" onSubmit={update}>
      <div className="gateway-metrics">
        <div><small>Attempts</small><strong>{number(gateway.total)}</strong></div>
        <div><small>Success rate</small><strong>{rate(gateway.successRate)}</strong></div>
        <div><small>Avg. response</small><strong>{gateway.averageResponseTimeMs == null ? '—' : gateway.averageResponseTimeMs + ' ms'}</strong></div>
      </div>
      <div className="tag-list">{gateway.supportedMethods.map(method => <span key={method}>{human(method)}</span>)}</div>
      <Field name="Priority"><input name="priority" type="number" required min={0} max={100} defaultValue={gateway.priority} /></Field>
      <label className="checkbox"><input type="checkbox" name="active" defaultChecked={gateway.active} /> Enable for this workspace</label>
      <Notice action={action} /><Button disabled={action.busy} kind="secondary">Save gateway</Button>
    </form>
    <details className="disclosure" onToggle={event => setProfileOpen(event.currentTarget.open)}><summary>Simulator profile</summary>
      <Result resource={health}>{data => <p className="panel-body">Baseline success {rate(data.baselineSuccessRate)} · baseline response {data.baselineResponseTimeMs} ms · system {data.systemActive ? 'enabled' : 'disabled'}</p>}</Result>
    </details>
  </Panel>;
}

export function Gateways() {
  const gateways = useResource('/gateways');
  return <>
    <PageTitle title="Gateways" description="Manage gateway eligibility and priority for your workspace."
      action={<Link className="button secondary" to="/analytics"><Activity size={17} /> View performance</Link>} />
    <Result resource={gateways}>{data => data.length ? <div className="gateway-grid">
      {data.map(gateway => <GatewayCard key={gateway.id} gateway={gateway} reload={gateways.reload} />)}
    </div> : <Empty>No gateways available.</Empty>}</Result>
  </>;
}

const labels = { availability: 'Availability', successRate: 'Success rate', responseTime: 'Response time', priority: 'Priority' };

function Weights({ config, reload }) {
  const action = useAction();
  async function save(event) {
    event.preventDefault();
    const weights = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, Number(value)]));
    const updated = await action.run(async () => {
      if (!Object.values(weights).some(weight => weight > 0)) invalid('Set at least one weight above zero.');
      return send('patch', '/routing/config', weights);
    }, 'Routing weights saved.');
    if (updated) reload();
  }
  return <form className="panel-body stack" onSubmit={save}>
    <div className="form-grid">{Object.entries(labels).map(([key, label]) => <Field key={key} name={label}>
      <input type="number" name={key} min={0} max={100} defaultValue={config.weights[key]} required />
    </Field>)}</div>
    <p className="muted">Weights determine the relative contribution of each factor on eligible gateways.</p>
    <Notice action={action} /><div><Button disabled={action.busy}>Save weights</Button></div>
  </form>;
}

export function Routing() {
  const settings = useResource('/routing/config');
  const [page, setPage] = useState(1);
  const decisions = useResource('/routing/decisions', { page }, 8000);
  const action = useAction();
  const [preview, setPreview] = useState(null);

  async function simulate(event) {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const result = await action.run(() => send('post', '/routing/preview', input));
    setPreview(result || null);
  }

  return <>
    <PageTitle title="Routing engine" description="Tune weighted routing and inspect which gateways qualified for each payment." />
    <div className="overview-grid detail-grid">
      <Panel title="Weighted strategy" subtitle="Adjust each factor from 0 to 100">
        <Result resource={settings}>{data => <Weights config={data} reload={settings.reload} />}</Result>
      </Panel>
      <Panel title="Preview routing" subtitle="Evaluate a sample payment without submitting it">
        <form onSubmit={simulate} className="panel-body stack">
          <div className="form-grid">
            <Field name="Amount in minor units"><input name="amountMinor" pattern="[1-9][0-9]{0,14}" defaultValue="1000" required inputMode="numeric" /></Field>
            <Field name="Payment method"><select name="paymentMethod">{methods.map(method => <option key={method} value={method}>{human(method)}</option>)}</select></Field>
          </div>
          <Notice action={action} /><div><Button disabled={action.busy} kind="secondary"><FlaskConical size={16} /> Evaluate gateways</Button></div>
        </form>
        {preview && <Decision decision={preview} />}
      </Panel>
    </div>
    <Panel title="Routing decisions">
      <Result resource={decisions}>{data => <>
        {data.items.length ? data.items.map(decision => <details className="disclosure" key={decision.id}>
          <summary>{dateTime(decision.createdAt)} · {decision.reason}</summary>
          <div className="panel-body"><Link className="record-link" to={'/transactions/' + decision.transactionId}>Open transaction</Link></div>
          <Decision decision={decision} />
        </details>) : <Empty>Routing decisions appear after payments are evaluated.</Empty>}
        <Pager {...data} onPage={setPage} />
      </>}</Result>
    </Panel>
  </>;
}

export function Webhooks() {
  const [page, setPage] = useState(1);
  const events = useResource('/webhooks', { page }, 6500);
  const retry = useAction();

  async function retryDelivery(id) {
    const result = await retry.run(() => send('post', '/webhooks/' + id + '/retry'));
    if (result) events.reload();
  }

  return <>
    <PageTitle title="Webhooks" description="Inspect signed gateway events, duplicate deliveries, and processing attempts." />
    <Notice action={retry} />
    <Panel title="Delivery log">
      <Result resource={events}>{data => <>
        {data.items.length ? <Table headers={['Event', 'Gateway', 'Type', 'Status', 'Deliveries', 'Received']}>
          {data.items.map(event => <tr key={event.id}>
            <td><details className="event"><summary className="record-link">{event.eventId}</summary>
              {event.transactionId && <Link to={'/transactions/' + event.transactionId}>View transaction</Link>}
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              <small>Processing attempts: {event.processingAttempts} · {dateTime(event.processedAt)}</small>
              {event.status === 'FAILED' && event.processingAttempts < 5 && <div className="event-action"><Button kind="secondary" disabled={retry.busy}
                onClick={() => retryDelivery(event.id)}>Retry processing</Button></div>}
            </details></td><td>{event.gateway.name}</td><td>{human(event.type)}</td><td><Badge value={event.status} /></td>
            <td>{event.deliveryCount}</td><td>{dateTime(event.receivedAt)}</td>
          </tr>)}
        </Table> : <Empty>No signed gateway events have been received for this workspace.</Empty>}
        <Pager {...data} onPage={setPage} />
      </>}</Result>
    </Panel>
  </>;
}

function SettlementForm() {
  const action = useAction();
  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const { amount, currency: rawCurrency, settledAt, ...input } = Object.fromEntries(new FormData(form));
    const currency = rawCurrency.trim().toUpperCase();
    const result = await action.run(() => {
      if (!/^[A-Z]{3}$/.test(currency)) invalid('Enter a three-letter currency code.');
      const amountMinor = toMinor(amount, currency);
      if (!amountMinor) invalid('Enter a positive amount using the selected currency precision.');
      return send('post', '/reconciliation/settlements', {
        ...input, currency, amountMinor, settledAt: settledAt ? new Date(settledAt).toISOString() : new Date().toISOString(),
      });
    }, 'Settlement entry imported.');
    if (result) form.reset();
  }

  return <details className="disclosure"><summary>Import a simulated settlement</summary>
    <form className="panel-body stack" onSubmit={submit}>
      <div className="form-grid">
        <Field name="Gateway"><select name="gateway">{Object.entries(gatewayNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></Field>
        <Field name="Gateway reference"><input name="gatewayReference" required maxLength={128} /></Field>
        <Field name="Amount"><input name="amount" inputMode="decimal" required maxLength={22} /></Field>
        <Field name="Currency"><input name="currency" defaultValue="USD" minLength={3} maxLength={3} required /></Field>
        <Field name="Status"><select name="status">{['SUCCESS', 'REFUNDED', 'FAILED', 'PENDING'].map(status => <option key={status} value={status}>{human(status)}</option>)}</select></Field>
        <Field name="Settlement time"><input name="settledAt" type="datetime-local" /></Field>
      </div>
      <Notice action={action} /><div><Button disabled={action.busy}>Import settlement</Button></div>
    </form>
  </details>;
}

function Report({ id }) {
  const report = useResource('/reconciliation/reports/' + id);
  const value = item => item && typeof item === 'object' ? money(item.amountMinor, item.currency) : item || '—';
  return <Result resource={report}>{data => <div className="report-detail">
    <p className="panel-body muted">{dateTime(data.periodStart)} to {dateTime(data.periodEnd)} · {data.checked} transactions checked</p>
    {data.details.length ? <Table headers={['Finding', 'Reference', 'Expected', 'Recorded']}>
      {data.details.map((detail, index) => <tr key={index}>
        <td className="strong">{human(detail.kind)}</td><td className="mono">{detail.paymentId
          ? <Link className="record-link" to={'/transactions/' + detail.paymentId}>{detail.reference}</Link> : detail.reference}</td>
        <td>{value(detail.expected)}</td><td>{detail.count ?? value(detail.actual)}</td>
      </tr>)}
    </Table> : <Empty>No discrepancies for this run.</Empty>}
  </div>}</Result>;
}

export function Reconciliation() {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const history = useResource('/reconciliation/reports', { page });
  const action = useAction();

  async function reconcile(event) {
    event.preventDefault();
    const { from, to } = Object.fromEntries(new FormData(event.currentTarget));
    const report = await action.run(() => send('post', '/reconciliation/run', dateWindow(from, to)), 'Reconciliation report generated.');
    if (report) { setPage(1); history.reload(); setSelected(report.id); }
  }

  return <>
    <PageTitle title="Reconciliation" description="Compare payment records with simulated gateway settlements." />
    <Panel title="Run reconciliation" subtitle="Period dates use UTC">
      <form className="panel-body reconcile-form" onSubmit={reconcile}>
        <Field name="From"><input name="from" type="date" defaultValue={isoDate(new Date(Date.now() - 7 * 86400000))} required /></Field>
        <Field name="Through"><input name="to" type="date" defaultValue={isoDate()} required /></Field>
        <Button disabled={action.busy}><CalendarDays size={16} /> {action.busy ? 'Comparing…' : 'Run comparison'}</Button>
      </form>
      <div className="panel-body"><Notice action={action} /></div>
      <SettlementForm />
    </Panel>
    <Panel title="Reports">
      <Result resource={history}>{data => <>
        {data.items.length ? <Table headers={['Run', 'Status', 'Checked', 'Matched', 'Mismatched', 'Missing', 'Duplicates']}>
          {data.items.map(report => <tr key={report.id}><td><button className="record-link text-button" onClick={() => setSelected(report.id)}>
            {dateTime(report.createdAt)}</button></td><td><Badge value={report.status} /></td><td>{report.checked}</td>
            <td>{report.matched}</td><td>{report.mismatched}</td><td>{report.missing}</td><td>{report.duplicates}</td></tr>)}
        </Table> : <Empty>No reconciliation reports yet.</Empty>}
        <Pager {...data} onPage={setPage} />
      </>}</Result>
    </Panel>
    {selected && <Panel title="Report details" action={<Button kind="secondary" onClick={() => setSelected(null)}>Close</Button>}><Report key={selected} id={selected} /></Panel>}
  </>;
}

function MerchantProfile({ data, refresh }) {
  const session = useSession();
  const action = useAction();
  async function update(event) {
    event.preventDefault();
    const { name } = Object.fromEntries(new FormData(event.currentTarget));
    const saved = await action.run(() => send('patch', '/settings', { name }), 'Workspace settings saved.');
    if (saved) { void session.refresh().catch(() => {}); refresh(); }
  }
  return <form className="panel-body stack" onSubmit={update}>
    <Field name="Workspace name"><input name="name" defaultValue={data.name} maxLength={120} required /></Field>
    <p className="muted">Workspace ID <span className="mono break">{data.id}</span></p>
    <Notice action={action} /><div><Button disabled={action.busy}>Save settings</Button></div>
  </form>;
}

export function Settings() {
  const { user } = useSession();
  const workspace = useResource(user.role === 'MERCHANT' ? '/settings' : null);
  return <>
    <PageTitle title="Settings" description="View your account and manage the workspace profile." />
    <div className="overview-grid detail-grid">
      <Panel title="Account" action={<ShieldCheck className="muted" size={21} />}>
        <dl className="definition-grid"><div><dt>Email</dt><dd className="break">{user.email}</dd></div>
          <div><dt>Role</dt><dd>{human(user.role)}</dd></div></dl>
      </Panel>
      {user.role === 'MERCHANT' && <Panel title="Workspace" action={<RadioTower className="muted" size={21} />}>
        <Result resource={workspace}>{data => <MerchantProfile data={data} refresh={workspace.reload} />}</Result>
      </Panel>}
    </div>
  </>;
}
