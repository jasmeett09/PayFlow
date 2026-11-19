import { ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import { Link } from 'react-router-dom';

export const methods = ['CARD', 'UPI', 'BANK_TRANSFER', 'WALLET'];
export const statuses = ['CREATED', 'PROCESSING', 'SUCCESS', 'FAILED', 'PENDING', 'REFUNDED', 'CANCELLED'];
export const gatewayNames = { 'gateway-a': 'Gateway A', 'gateway-b': 'Gateway B', 'gateway-c': 'Gateway C' };

export function human(value = '') {
  return value.toLowerCase().replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
}

export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function dateWindow(from, to) {
  return {
    ...(from ? { from: new Date(from).toISOString() } : {}),
    ...(to ? { to: new Date(Date.parse(to) + 86_400_000).toISOString() } : {}),
  };
}

export const dateTime = value => value ? new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) : '—';

export const number = value => value == null ? '—' : new Intl.NumberFormat().format(value);
export const rate = value => value == null ? '—' : new Intl.NumberFormat(undefined, {
  style: 'percent', maximumFractionDigits: 1,
}).format(value);

function currencyDigits(currency) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

export function money(minor, currency) {
  const digits = currencyDigits(currency);
  const units = BigInt(minor);
  const factor = 10n ** BigInt(digits);
  const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(units / factor);
  const cents = String(units % factor).padStart(digits, '0');
  return parts.map(part => part.type === 'fraction' ? cents : part.value).join('');
}

export function toMinor(value, currency) {
  const digits = currencyDigits(currency);
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > digits) return null;
  const amount = BigInt(whole + fraction.padEnd(digits, '0'));
  return amount > 0n && amount <= 999999999999999n ? String(amount) : null;
}

export function Button({ children, kind = 'primary', ...props }) {
  return <button className={'button ' + kind} {...props}>{children}</button>;
}

export function Field({ name, children, className = '' }) {
  return <label className={'field ' + className}><span>{name}</span>{children}</label>;
}

export function PageTitle({ title, description, action }) {
  return <div className="page-title"><div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

export function Panel({ title, subtitle, action, children, className = '' }) {
  return <section className={'panel ' + className}>
    {(title || action) && <div className="panel-heading">
      <div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>
      {action}
    </div>}
    {children}
  </section>;
}

export function Badge({ value }) {
  if (!value) return <span className="muted">—</span>;
  const color = ['SUCCESS', 'HEALTHY', 'PROCESSED', 'MATCHED', 'ACTIVE'].includes(value) ? 'good'
    : ['FAILED', 'UNHEALTHY', 'DECLINED'].includes(value) ? 'bad'
      : ['PENDING', 'PROCESSING', 'DEGRADED', 'UNCERTAIN', 'DISCREPANCIES', 'RECEIVED'].includes(value) ? 'warn'
        : 'neutral';
  return <span className={'badge ' + color}><i aria-hidden="true" />{human(value)}</span>;
}

export function Empty({ children }) {
  return <div className="empty"><Inbox size={20} aria-hidden="true" /><p>{children}</p></div>;
}

export function Notice({ action }) {
  return action.error ? <p role="alert" className="notice error">{action.error}</p>
    : action.success ? <p role="status" className="notice success">{action.success}</p> : null;
}

export function Result({ resource, children }) {
  if (resource.loading) return <div role="status" className="loading"><span />Loading…</div>;
  if (resource.error) return <div role="alert" className="notice error">
    <span>{resource.error}</span> <Button kind="secondary" onClick={resource.reload}>Retry</Button>
  </div>;
  return resource.data == null ? null : children(resource.data);
}

export function Table({ headers, children, className = '' }) {
  return <div className={'table-scroll ' + className}><table><thead><tr>
    {headers.map(header => <th key={header} scope="col">{header}</th>)}
  </tr></thead><tbody>{children}</tbody></table></div>;
}

export function Pager({ total, page, limit, onPage }) {
  return <div className="pager"><span>{total ? `${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total}` : '0 results'}</span>
    <div><Button kind="secondary" aria-label="Previous page" disabled={page === 1} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></Button>
      <Button kind="secondary" aria-label="Next page" disabled={page * limit >= total} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></Button></div>
  </div>;
}

export function PaymentRows({ items, empty = 'No payments found.' }) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return <Table className="payment-table" headers={['Transaction', 'Amount', 'Method', 'Gateway', 'Status', 'Created']}>
    {items.map(payment => <tr key={payment.id}>
      <td><Link className="record-link" to={'/transactions/' + payment.id}>{payment.merchantReference || payment.id.slice(0, 12)}</Link>
        {payment.merchantReference && <small className="mono cell-detail">{payment.id.slice(0, 12)}</small>}</td>
      <td className="strong">{money(payment.amountMinor, payment.currency)}</td>
      <td>{human(payment.paymentMethod)}</td><td>{payment.merchantGateway?.gateway.name || '—'}</td>
      <td><Badge value={payment.status} /></td><td>{dateTime(payment.createdAt)}</td>
    </tr>)}
  </Table>;
}

export function FilterFields({ filters, update, includeSort = false }) {
  return <>
    <Field name="Status"><select value={filters.status || ''} onChange={event => update('status', event.target.value)}>
      <option value="">All statuses</option>{statuses.map(status => <option key={status} value={status}>{human(status)}</option>)}
    </select></Field>
    <Field name="Gateway"><select value={filters.gateway || ''} onChange={event => update('gateway', event.target.value)}>
      <option value="">All gateways</option>{Object.entries(gatewayNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select></Field>
    <Field name="Method"><select value={filters.method || ''} onChange={event => update('method', event.target.value)}>
      <option value="">All methods</option>{methods.map(method => <option key={method} value={method}>{human(method)}</option>)}
    </select></Field>
    <Field name="From"><input type="date" value={filters.from || ''} max={filters.to || undefined} onChange={event => update('from', event.target.value)} /></Field>
    <Field name="Through"><input type="date" value={filters.to || ''} min={filters.from || undefined} onChange={event => update('to', event.target.value)} /></Field>
    {includeSort && <Field name="Sort"><select value={filters.sort} onChange={event => update('sort', event.target.value)}>
      <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="amount-high">Highest amount</option><option value="amount-low">Lowest amount</option>
    </select></Field>}
  </>;
}

export function filterQuery({ from, to, ...filters }) {
  return { ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)), ...dateWindow(from, to) };
}
