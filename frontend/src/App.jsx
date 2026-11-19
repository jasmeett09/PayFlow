import { Activity, ArrowLeftRight, ChartNoAxesCombined, CircleUserRound, Compass, CreditCard, GitFork, Layers3,
  LogOut, Menu, RadioTower, Settings as SettingsIcon, ShieldCheck, Webhook, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { send, tokenKey, useAction } from './api.js';
import { Button, Field, Notice } from './components/shared.jsx';
import { Session, useSession } from './session.js';
import { PaymentDetails, Transactions } from './pages/Transactions.jsx';
import { Gateways, Reconciliation, Routing, Settings, Webhooks } from './pages/Operations.jsx';

const Overview = lazy(() => import('./pages/Overview.jsx').then(module => ({ default: module.Overview })));
const Analytics = lazy(() => import('./pages/Overview.jsx').then(module => ({ default: module.Analytics })));

const navigation = [
  ['Overview', '/overview', Compass],
  ['Transactions', '/transactions', ArrowLeftRight],
  ['Gateways', '/gateways', RadioTower],
  ['Routing engine', '/routing', GitFork],
  ['Webhooks', '/webhooks', Webhook],
  ['Reconciliation', '/reconciliation', Layers3],
  ['Analytics', '/analytics', ChartNoAxesCombined],
  ['Settings', '/settings', SettingsIcon],
];

function Logo() {
  return <span className="logo"><span><CreditCard size={21} strokeWidth={2.4} /></span>PayFlow</span>;
}

function Auth({ register = false }) {
  const session = useSession();
  const action = useAction();
  const navigate = useNavigate();
  const visual = useRef(null);
  useEffect(() => {
    if (!visual.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let animation;
    let current = true;
    void import('gsap').then(({ gsap }) => {
      if (!current || !visual.current) return;
      animation = gsap.context(() => gsap.from('.flow-step', {
        y: 18, opacity: 0, duration: 0.42, stagger: 0.09, ease: 'power2.out', clearProps: 'all',
      }), visual);
    }).catch(() => {});
    return () => { current = false; animation?.revert(); };
  }, [session.loading, session.user]);
  if (session.loading) return <div className="session-loading">Loading PayFlow…</div>;
  if (session.user) return <Navigate replace to="/overview" />;

  async function submit(event) {
    event.preventDefault();
    const { email, password, merchantName } = Object.fromEntries(new FormData(event.currentTarget));
    const data = await action.run(() => send('post', register ? '/auth/register' : '/auth/login', {
      email, password, ...(register ? { merchantName } : {}),
    }));
    if (data) {
      session.signIn(data);
      navigate('/overview', { replace: true });
    }
  }

  return <main className="auth-shell">
    <section className="auth-form"><Logo /><div className="auth-center">
      <h1>{register ? 'Create your workspace' : 'Sign in to PayFlow'}</h1>
      <p>{register ? 'Set up a merchant account to run simulated payments.' : 'Manage your payments, gateways, and settlements.'}</p>
      <form onSubmit={submit} className="stack">
        {register && <Field name="Merchant name"><input required name="merchantName" maxLength={120} autoComplete="organization" /></Field>}
        <Field name="Email"><input required name="email" type="email" autoComplete="email" placeholder="you@example.com" /></Field>
        <Field name="Password"><input required name="password" type="password" minLength={register ? 12 : undefined}
          autoComplete={register ? 'new-password' : 'current-password'} placeholder={register ? 'At least 12 characters' : ''} /></Field>
        <Notice action={action} />
        <Button disabled={action.busy}>{action.busy ? 'Please wait…' : register ? 'Create workspace' : 'Sign in'}</Button>
      </form>
      <p className="auth-switch">{register ? 'Have an account?' : 'New to PayFlow?'}{' '}
        <Link to={register ? '/login' : '/register'}>{register ? 'Sign in' : 'Create a workspace'}</Link></p>
    </div><div className="auth-foot"><ShieldCheck size={16} /> Simulation environment</div></section>
    <aside className="auth-visual" ref={visual}>
      <div className="auth-visual-inner">
        <p className="flow-step auth-eyebrow">PAYMENT ORCHESTRATION</p>
        <h2 className="flow-step">A reliable route for every payment.</h2>
        <p className="flow-step">Route simulated transactions across three gateways and follow each decision through settlement.</p>
        <div className="flow-step flow-illustration">
          <div><CreditCard size={22} /><strong>Payment request</strong><small>Merchant workspace</small></div>
          <div><GitFork size={22} /><strong>Routing engine</strong><small>Weighted eligibility</small></div>
          <div><Activity size={22} /><strong>Gateway selection</strong><small>Health and performance</small></div>
        </div>
      </div>
    </aside>
  </main>;
}

function Shell() {
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = event => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);
  if (session.loading) return <div className="session-loading" role="status">Loading PayFlow…</div>;
  if (!session.user) return <Navigate replace to="/login" />;
  const isAdmin = session.user.role === 'ADMIN';
  const workspace = session.user.merchant?.name || 'Platform administration';
  const visible = isAdmin ? navigation.filter(([, path]) => ['/overview', '/analytics', '/settings'].includes(path)) : navigation;
  const current = visible.find(([, path]) => location.pathname.startsWith(path))?.[0] || 'Workspace';

  return <div className="app-shell">
    <a className="skip" href="#main-content">Skip to content</a>
    {menuOpen && <button className="mobile-overlay" onClick={() => setMenuOpen(false)} aria-label="Close navigation" />}
    <aside id="workspace-navigation" className={'sidebar ' + (menuOpen ? 'open' : '')}>
      <div className="sidebar-brand"><Link to="/overview" aria-label="PayFlow overview"><Logo /></Link>
        <button className="icon-button close-menu" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={20} /></button></div>
      <div className="workspace"><span className="workspace-icon">{workspace.slice(0, 2).toUpperCase()}</span><div><strong>{workspace}</strong><small>{isAdmin ? 'Administrator' : 'Merchant workspace'}</small></div></div>
      <nav aria-label="Workspace"><div className="nav-label">WORKSPACE</div>
        {visible.filter(([, path]) => path !== '/settings').map(([name, path, Icon]) =>
          <NavLink key={path} to={path}><Icon size={18} />{name}</NavLink>)}
        <div className="nav-label account-label">ACCOUNT</div>
        <NavLink to="/settings"><SettingsIcon size={18} />Settings</NavLink>
      </nav>
      <div className="sidebar-bottom"><div className="sandbox-tag"><span />Simulation mode</div>
        <button className="sign-out" onClick={session.signOut}><LogOut size={17} /> Sign out</button></div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="topbar-location"><button className="icon-button menu-button" onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="workspace-navigation"><Menu size={22} /></button>
          <span className="topbar-root">Workspace</span><span className="topbar-slash">/</span><strong>{current}</strong></div>
        <Link className="account-chip" to="/settings" title={session.user.email} aria-label="Account settings"><CircleUserRound size={18} /><span>{session.user.email}</span></Link>
      </header>
      <main id="main-content" className="main-content"><Suspense fallback={<div className="loading" role="status">Loading…</div>}><Outlet /></Suspense></main>
    </div>
  </div>;
}

function MerchantOnly({ children }) {
  return useSession().user.role === 'MERCHANT' ? children : <Navigate replace to="/overview" />;
}

export function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => Boolean(sessionStorage.getItem(tokenKey)));
  function signOut() {
    sessionStorage.removeItem(tokenKey);
    setUser(null);
    setLoading(false);
  }
  useEffect(() => {
    const controller = new AbortController();
    if (sessionStorage.getItem(tokenKey)) {
      send('get', '/auth/me', undefined, { signal: controller.signal })
        .then(setUser)
        .catch(error => { if (!controller.signal.aborted && error.response?.status === 401) signOut(); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    window.addEventListener('payflow-session-expired', signOut);
    return () => {
      controller.abort();
      window.removeEventListener('payflow-session-expired', signOut);
    };
  }, []);
  const session = {
    user, loading, signOut,
    signIn(data) { sessionStorage.setItem(tokenKey, data.accessToken); setUser(data.user); },
    async refresh() { setUser(await send('get', '/auth/me')); },
  };

  return <Session.Provider value={session}><Routes>
    <Route path="/login" element={<Auth />} /><Route path="/register" element={<Auth key="register" register />} />
    <Route element={<Shell />}>
      <Route index element={<Navigate replace to="/overview" />} />
      <Route path="/overview" element={<Overview />} />
      <Route path="/analytics" element={<Analytics />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/transactions" element={<MerchantOnly><Transactions /></MerchantOnly>} />
      <Route path="/transactions/:id" element={<MerchantOnly><PaymentDetails /></MerchantOnly>} />
      <Route path="/gateways" element={<MerchantOnly><Gateways /></MerchantOnly>} />
      <Route path="/routing" element={<MerchantOnly><Routing /></MerchantOnly>} />
      <Route path="/webhooks" element={<MerchantOnly><Webhooks /></MerchantOnly>} />
      <Route path="/reconciliation" element={<MerchantOnly><Reconciliation /></MerchantOnly>} />
    </Route>
    <Route path="*" element={<Navigate replace to="/" />} />
  </Routes></Session.Provider>;
}
