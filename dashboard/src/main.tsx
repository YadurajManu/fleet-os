import React, { Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import Shell from './components/Shell'
import SignIn from './pages/SignIn'
import Overview from './pages/Overview'
import Nodes from './pages/Nodes'
import NodeDetail from './pages/NodeDetail'
import Services from './pages/Services'
import ServiceDetail from './pages/ServiceDetail'
import Events from './pages/Events'
import Alerts from './pages/Alerts'
import Secrets from './pages/Secrets'
import Settings from './pages/Settings'
import Doctor from './pages/Doctor'
import Logs from './pages/Logs'
import AuditHistory from './pages/AuditHistory'
import CliAuth from './pages/CliAuth'
import ResetPassword from './pages/ResetPassword'
import VerifyEmail from './pages/VerifyEmail'
import ConfirmEmail from './pages/ConfirmEmail'
import CloseAccountConfirm from './pages/CloseAccountConfirm'
import AuthCallback from './pages/AuthCallback'
import NotFound from './pages/NotFound'
import { Logo } from './components/ui'
import { api } from './lib/api'
import './index.css'

const Ops = lazy(() => import('./pages/Ops'))

function OpsGate() {
  const { ready, email, verified } = useAuth()
  const [access, setAccess] = useState<'checking' | 'allowed' | 'denied'>('checking')
  useEffect(() => {
    if (!ready || !email || !verified) return
    let active = true
    void api('/ops/me').then(() => { if (active) setAccess('allowed') }).catch(() => { if (active) setAccess('denied') })
    return () => { active = false }
  }, [ready, email, verified])
  if (!ready) return <div className="p-8">Checking session…</div>
  if (!email) return <Routes>
    <Route path="/auth/callback" element={<AuthCallback />} />
    <Route path="/reset" element={<ResetPassword />} />
    <Route path="/verify" element={<VerifyEmail />} />
    <Route path="/account/close" element={<CloseAccountConfirm />} />
    <Route path="*" element={<SignIn />} />
  </Routes>
  if (!verified) return <ConfirmEmail />
  if (access === 'checking') return <div className="p-8">Checking operator access…</div>
  if (access === 'denied') return <div className="mx-auto mt-24 max-w-lg border border-[var(--color-line-2)] p-8"><h1 className="text-xl font-semibold">Operations access required</h1><p className="mt-3 text-[var(--color-fg-muted)]">This account needs a platform-operator grant, verified email, and two-factor authentication. Customer fleet roles do not grant access.</p></div>
  return <Suspense fallback={<div className="p-8">Loading Operations…</div>}><Ops /></Suspense>
}

function Gate() {
  const { ready, email, verified } = useAuth()

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Logo size={30} />
      </div>
    )
  }
  // Reset, verify, and auth/callback have to be reachable while signed out.
  if (!email) {
    return (
      <Routes>
        <Route path="auth/callback" element={<AuthCallback />} />
        <Route path="reset" element={<ResetPassword />} />
        <Route path="verify" element={<VerifyEmail />} />
        <Route path="account/close" element={<CloseAccountConfirm />} />
        <Route index element={<SignIn />} />
        <Route path="login" element={<SignIn />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    )
  }

  if (verified === false) {
    return (
      <Routes>
        <Route path="auth/callback" element={<AuthCallback />} />
        <Route path="verify" element={<VerifyEmail />} />
        <Route path="account/close" element={<CloseAccountConfirm />} />
        <Route path="*" element={<ConfirmEmail />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="auth/callback" element={<AuthCallback />} />
      <Route path="cli-auth" element={<CliAuth />} />
      <Route path="reset" element={<ResetPassword />} />
      <Route path="verify" element={<VerifyEmail />} />
      <Route path="account/close" element={<CloseAccountConfirm />} />
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="nodes" element={<Nodes />} />
        <Route path="nodes/:nodeId" element={<NodeDetail />} />
        <Route path="services" element={<Services />} />
        <Route path="services/:serviceId" element={<ServiceDetail />} />
        <Route path="events" element={<Events />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="secrets" element={<Secrets />} />
        <Route path="doctor" element={<Doctor />} />
        <Route path="logs" element={<Logs />} />
        <Route path="settings" element={<Settings />} />
        <Route path="audit" element={<AuditHistory />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {window.location.hostname.startsWith('ops.') ? <OpsGate /> : <Gate />}
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
