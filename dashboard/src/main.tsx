import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
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
import { Logo } from './components/ui'
import './index.css'

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
        <Route path="*" element={<SignIn />} />
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
