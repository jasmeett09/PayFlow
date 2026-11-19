import { ArrowLeft, Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { invalid, send, useAction, useResource } from '../api.js';
import {
  Badge, Button, Empty, Field, FilterFields, Notice, PageTitle, Pager, Panel, PaymentRows, Result, Table,
  dateTime, filterQuery, human, methods, money, toMinor,
} from '../components/shared.jsx';

const scenarios = {
  NORMAL: 'Normal gateway behavior',
  DECLINE: 'Terminal business decline',
  FAILOVER: 'Retryable gateway failure',
  TIMEOUT_SUCCESS: 'Timeout, then confirmed success',
  TIMEOUT_UNKNOWN: 'Timeout, awaiting webhook',
  TIMEOUT_FAILOVER: 'Timeout, then confirmed no charge',
};

function NewPayment({ close, created }) {
  const action = useAction();
  const first = useRef(null);
  const submission = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  async function submit(event) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const currency = form.currency.trim().toUpperCase();
    const result = await action.run(async () => {
      if (!/^[A-Z]{3}$/.test(currency)) invalid('Enter a three-letter currency code.');
      const amountMinor = toMinor(form.amount, currency);
      if (!amountMinor) invalid('Enter a positive amount using the precision of the selected currency.');
      const data = {
        amountMinor, currency, paymentMethod: form.paymentMethod, scenario: form.scenario,
        ...(form.merchantReference.trim() ? { merchantReference: form.merchantReference.trim() } : {}),
      };
      const fingerprint = JSON.stringify(data);
      if (submission.current?.fingerprint !== fingerprint) {
        submission.current = { fingerprint, key: crypto.randomUUID() };
      }
      return send('post', '/payments', data, { headers: { 'Idempotency-Key': submission.current.key } });
    });
    if (result) created(result.id);
  }

  return <Panel title="Create a simulated payment" subtitle="Use synthetic values. Payment and card credentials are never required."
    action={<Button type="button" kind="secondary" onClick={close}>Close</Button>}>
    <form onSubmit={submit} className="panel-body stack">
      <div className="form-grid">
        <Field name="Amount"><input ref={first} name="amount" inputMode="decimal" placeholder="125.00" required maxLength={22} /></Field>
        <Field name="Currency"><input name="currency" defaultValue="USD" maxLength={3} minLength={3} required /></Field>
        <Field name="Payment method"><select name="paymentMethod">{methods.map(method => <option key={method} value={method}>{human(method)}</option>)}</select></Field>
        <Field name="Merchant reference"><input name="merchantReference" placeholder="Order reference" maxLength={120} /></Field>
        <Field name="Simulator scenario"><select name="scenario">{Object.entries(scenarios).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      </div>
      <Notice action={action} /><div><Button disabled={action.busy}>{action.busy ? 'Submitting…' : 'Submit payment'}</Button></div>
    </form>
  </Panel>;
}

export function Transactions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const showNew = searchParams.has('new');
  const [filters, setFilters] = useState({ sort: 'newest' });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const ledger = useResource('/payments', { ...filterQuery(filters), page }, 6000);

  function update(name, value) {
    setFilters(previous => ({ ...previous, [name]: value }));
    setPage(1);
  }

  return <>
    <PageTitle title="Transactions" description="Search the payment ledger and inspect individual transactions."
      action={<Button onClick={() => setSearchParams({ new: '1' })}><Plus size={17} /> New payment</Button>} />
    {showNew && <NewPayment close={() => setSearchParams({})} created={id => navigate('/transactions/' + id)} />}
    <Panel>
      <form className="search-form" onSubmit={event => { event.preventDefault(); update('search', search.trim()); }}>
        <label className="search-input"><Search size={17} /><input aria-label="Transaction ID or merchant reference"
          value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by transaction ID or merchant reference" maxLength={120} /></label>
        <Button kind="secondary">Search</Button>
        {filters.search && <Button type="button" kind="quiet" onClick={() => { setSearch(''); update('search', ''); }}>Clear</Button>}
      </form>
      <div className="filter-grid"><FilterFields filters={filters} update={update} includeSort /></div>
    </Panel>
    <Panel title="Payment ledger">
      <Result resource={ledger}>{data => <>
        <PaymentRows items={data.items} />
        <Pager {...data} onPage={setPage} />
      </>}</Result>
    </Panel>
  </>;
}

export function Decision({ decision }) {
  return <div className="decision"><p>{decision.reason}</p>
    <Table headers={['Gateway', 'Score', 'Eligibility']}>
      {decision.candidates.map(candidate => <tr key={candidate.gatewayId}><td className="strong">{candidate.name}</td>
        <td className="mono">{candidate.score == null ? '—' : candidate.score.toFixed(3)}</td>
        <td>{candidate.exclusion || (candidate.gatewayId === decision.selectedGatewayId ? 'Selected' : 'Eligible')}</td></tr>)}
    </Table>
  </div>;
}

export function PaymentDetails() {
  const { id } = useParams();
  const payment = useResource('/payments/' + id, undefined, 2200);
  const action = useAction();
  const [confirmation, setConfirmation] = useState(null);

  async function apply() {
    const result = await action.run(() => send('post', '/payments/' + id + '/' + confirmation),
      confirmation === 'refund' ? 'Refund recorded.' : 'Payment cancelled.');
    setConfirmation(null);
    if (result) payment.reload();
  }

  return <>
    <Link to="/transactions" className="back-link"><ArrowLeft size={15} /> Transactions</Link>
    <PageTitle title="Transaction details" description={id} />
    <Notice action={action} />
    <Result resource={payment}>{data => <>
      <Panel title={money(data.amountMinor, data.currency)} subtitle={data.merchantReference || undefined}
        action={<Badge value={data.status} />} className="payment-summary">
        <dl className="definition-grid">
          <div><dt>Method</dt><dd>{human(data.paymentMethod)}</dd></div>
          <div><dt>Gateway</dt><dd>{data.merchantGateway?.gateway.name || '—'}</dd></div>
          <div><dt>Created</dt><dd>{dateTime(data.createdAt)}</dd></div>
          <div><dt>Updated</dt><dd>{dateTime(data.updatedAt)}</dd></div>
          <div className="wide"><dt>Gateway reference</dt><dd className="mono break">{data.gatewayReference || '—'}</dd></div>
        </dl>
        {data.failureReason && <p className="panel-body status-note">{data.failureReason}</p>}
        {(data.status === 'SUCCESS' || ['CREATED', 'PROCESSING'].includes(data.status) || confirmation) &&
          <div className="panel-body action-row">
            {confirmation ? <><span>{confirmation === 'refund' ? 'Refund the full simulated payment?' : 'Cancel this payment?'}</span>
              <Button onClick={apply} disabled={action.busy}>Confirm {confirmation}</Button>
              <Button kind="quiet" disabled={action.busy} onClick={() => setConfirmation(null)}>Go back</Button></>
              : <Button kind="secondary" onClick={() => setConfirmation(data.status === 'SUCCESS' ? 'refund' : 'cancel')}>
                {data.status === 'SUCCESS' ? 'Refund payment' : 'Cancel payment'}</Button>}
          </div>}
      </Panel>
      <div className="overview-grid detail-grid">
        <Panel title="Activity timeline">{data.auditLogs.length ? <ol className="timeline">
          {data.auditLogs.map(log => <li key={log.id}><span className="timeline-dot" /><div>
            <strong>{log.metadata?.to ? human(log.metadata.to) : human(log.action)}</strong>
            <small>{dateTime(log.createdAt)}</small>
            {(log.metadata?.reason || log.metadata?.outcome) && <p>{log.metadata.reason || human(log.metadata.outcome)}</p>}
          </div></li>)}</ol> : <Empty>No activity recorded.</Empty>}</Panel>
        <Panel title="Gateway attempts">{data.attempts.length ? <ul className="attempt-list">
          {data.attempts.map(attempt => <li key={attempt.id}><div><strong>{attempt.merchantGateway.gateway.name}</strong>
            <small>Attempt {attempt.sequence} · {attempt.responseTimeMs ?? '—'} ms · {attempt.verificationCount} status checks</small>
            {attempt.failureReason && <p>{attempt.failureReason}</p>}</div><Badge value={attempt.status} /></li>)}
        </ul> : <Empty>No attempts yet.</Empty>}</Panel>
      </div>
      <Panel title="Routing decisions" subtitle="Eligibility and scores recorded at each attempt">
        {data.routingDecisions.length ? data.routingDecisions.map(decision =>
          <details className="disclosure" key={decision.id}><summary>{dateTime(decision.createdAt)} · {decision.reason}</summary>
            <Decision decision={decision} /></details>) : <Empty>No routing decisions yet.</Empty>}
      </Panel>
      {Boolean(data.refunds.length) && <Panel title="Refunds"><Table headers={['Refund', 'Amount', 'Status', 'Created']}>
        {data.refunds.map(refund => <tr key={refund.id}><td className="mono">{refund.id}</td>
          <td>{money(refund.amountMinor, data.currency)}</td><td><Badge value={refund.status} /></td><td>{dateTime(refund.createdAt)}</td></tr>)}
      </Table></Panel>}
    </>}</Result>
  </>;
}
