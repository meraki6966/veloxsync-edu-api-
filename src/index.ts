import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import authRoutes from './routes/auth'
import dashboardRoutes from './routes/dashboard'
import educationV2Routes from './routes/education-v2'
import eduBillingRoutes from './routes/edu-billing'
import eduIntegrationsRoutes, { gcOAuthRouter } from './routes/edu-integrations'
import eduParentPortalRoutes from './routes/edu-parent-portal'
import eduSupportRoutes from './routes/edu-support'
import { authMiddleware } from './middleware/auth'
import { eduTrialCheck } from './middleware/eduTrialCheck'
import { runMigrations } from './db/migrate'

dotenv.config()

const app = express()

app.use(helmet())
app.use(cors({ origin: process.env.FRONTEND_URL || 'https://education.veloxsync.app', credentials: true }))
app.use('/api/edu/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'veloxsync-edu-api' }))

// Public auth routes (register, login) — must be mounted before authMiddleware-guarded routes
app.use('/api/auth', authRoutes)

// Dashboard routes (e.g. /me) — protected by authMiddleware, used to verify a session on page load
app.use('/api/dashboard', authMiddleware, dashboardRoutes)

// Support contact — public (no auth) so logged-out users can reach support
app.use('/api/edu/support', eduSupportRoutes)
app.use('/api/edu/parent', eduParentPortalRoutes)
app.use('/api/edu/billing', eduBillingRoutes)
app.use('/api/edu', authMiddleware, eduTrialCheck, educationV2Routes)
// Google Classroom OAuth — public (no auth): /auth redirect + /callback from Google
app.use('/api/edu/integrations', gcOAuthRouter)
// All other edu-integrations routes require auth + trial check
app.use('/api/edu/integrations', authMiddleware, eduTrialCheck, eduIntegrationsRoutes)

const PORT = parseInt(process.env.PORT || '8080', 10)

;(async () => {
  await runMigrations()
  app.listen(PORT, () => console.log(`VeloxSync Edu API running on port ${PORT}`))
})()
