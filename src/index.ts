import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { Pool } from 'pg'
import educationV2Routes from './routes/education-v2'
import eduBillingRoutes from './routes/edu-billing'
import eduIntegrationsRoutes from './routes/edu-integrations'
import eduParentPortalRoutes from './routes/edu-parent-portal'
import { authMiddleware } from './middleware/auth'
import { eduTrialCheck } from './middleware/eduTrialCheck'

dotenv.config()

export const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const app = express()

app.use(helmet())
app.use(cors({ origin: process.env.FRONTEND_URL || 'https://education.veloxsync.app', credentials: true }))
app.use('/api/edu/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

app.get('/health', (_, res) => res.json({ status: 'ok', service: 'veloxsync-edu-api' }))

app.use('/api/edu/parent', eduParentPortalRoutes)
app.use('/api/edu/billing', eduBillingRoutes)
app.use('/api/edu', authMiddleware, eduTrialCheck, educationV2Routes)
app.use('/api/edu/integrations', authMiddleware, eduTrialCheck, eduIntegrationsRoutes)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`VeloxSync Edu API running on port ${PORT}`))
