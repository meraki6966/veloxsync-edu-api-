# Soulful Tech — Master Build Plan
**Last updated:** May 11, 2026  
**Founder:** Adam McClarin — Meraki is Love, LLC  
**Brand tagline:** Soulful Tech. Technology built with intention and purpose.

---

## Active Products

| Product | Repo (Frontend) | Repo (Backend) | Domain | Status |
|---|---|---|---|---|
| VeloxSync HR | aetherflow-web | aetherflow-api | veloxsync.app | Live — V2 redesign complete |
| VeloxSync for Education | veloxsync-edu-web | veloxsync-edu-api- | education.veloxsync.app | Extraction in progress |
| Nail Check | (separate repo) | (separate repo) | nail-check.com | Live |
| Meraki Lingua | (separate repo) | (separate repo) | TBD | In development |

---

## Tech Stack Reference

### Frontend
- React + TypeScript + Vite
- Tailwind CSS + DaisyUI Kit (React projects — VeloxSync, Nail Check, Meraki Lingua)
- Bulma CSS (WordPress themes, static client sites, no-build-step deliverables)
- V2 Design System tokens in `src/styles/vs-components.css`
- Vercel for deployment

### Backend
- Node.js + Express + TypeScript
- PostgreSQL on Railway
- Railway for deployment

### AI Layer
- VeloxSync HR: Fine-tuned Meta-Llama 3 8B via Together.ai
  - Model: `mcclarin96_c50a/Meta-Llama-3-8B-Instruct-90e7637c-0e0e23f2`
  - Env: `MOCK_AI=false`, `NODE_ENV=production`
- VeloxSync for Education: Claude Sonnet 4 via Anthropic API
  - All curriculum, assignment, student insight, pacing, differentiation functions
  - Env: `ANTHROPIC_API_KEY`

### Other Services
- Stripe (billing — separate price IDs for HR and Education plans)
- ElevenLabs (voice clone for demo videos)
- Cloudinary (image hosting)
- Resend (transactional email)
- Google OAuth (Google Classroom integration)
- Finch (220+ HRIS integrations)
- LTX Desktop API (video generation)

---

## VeloxSync HR Design System

### Colors
```css
--vs-void: #000000
--vs-deep: #080810
--vs-panel: #0D0D1A
--vs-card: #111122
--vs-amber: #D4A017
--vs-amber-bright: #F5B800
--vs-teal: #0B9B8A
--vs-white: #F0EDE8
--vs-red: #E53E3E
--vs-green: #38A169
```

### Typography
- Display: Bebas Neue
- Monospace / data labels: Space Mono
- Body: DM Sans

### Aesthetic
Signal intelligence command center. Sharp corners, amber gold accents, dark panels, Space Mono data readouts, Bebas Neue headlines. Reference: veloxsync.app landing page.

---

## VeloxSync HR — Pricing (Current V2)

| Plan | Price | Seats |
|---|---|---|
| Spark | $19/mo | Up to 25 employees |
| Momentum | $35/mo | Up to 75 employees |
| Harmony | $55/mo | Up to 200 employees |
| Ascent | $95/seat/mo | Unlimited |

---

## VeloxSync Education — Pricing

| Plan | Price | For |
|---|---|---|
| Teacher Pro | $9/mo | Individual teachers, up to 35 students |
| Campus | $12/teacher/mo | Schools, unlimited students |
| District | $199/school/mo | Multi-campus districts |
| Homeschool | $6/mo | Homeschool families |

---

## VeloxSync HR — Ei-Core Context

Ei-Core pulls real employee data before every AI response:
- Top 5 at-risk employees by burnout score
- Org wellness averages (last 7 days)
- Filters out education student records (`department NOT LIKE '%Grade%'`)
- Organization ID always comes from JWT, never request body

---

## Roadmap — Immediate Next Session

### 1. Security Testing Script
Build `security/security-tests.cjs` in `aetherflow-api`.
Runs automatically before every major release or enterprise demo.

Tests to include:
- **BOLA**: Cross-org ID manipulation on all major endpoints
  - GET /api/employees/:id
  - GET /api/teams/:id
  - GET /api/succession/critical-roles
  - GET /api/wellness-scores/:id
  - All /api/edu/* endpoints
- **RBAC**: Role escalation attempts across User / Manager / Admin / Super Admin
- **Auth**: Expired tokens, tampered JWTs, missing tokens, brute force rate limiting
- **Output**: Pass/fail report saved to `security/reports/YYYY-MM-DD.txt`

Workflow integration:
```
Code change → Claude Code builds → Push to main →
Railway deploys → Run security-tests.cjs →
Pass = demo ready / Fail = fix before showing anyone
```

---

## Roadmap — Education Extraction (4 Sessions)

### Session 2 — Fix Errors + Deploy
**Frontend fixes (veloxsync-edu-web):**
- Clean git history: squash node_modules pollution from commit `0913b183`
- Copy `src/types/education.ts` from aetherflow-web
- Copy `src/components/AssignmentModal.tsx` from aetherflow-web
- Target: zero TypeScript errors

**Backend fixes (veloxsync-edu-api-):**
- `npm install helmet @types/helmet`
- Copy `src/services/signalEngine.ts` from aetherflow-api
- Copy `src/services/alertNotifier.ts` from aetherflow-api
- Copy `src/services/conflictEngine.ts` from aetherflow-api
- Fix double pool instance (db.ts vs index.ts)
- Add gcOAuthRouter public mount before auth-protected mount
- Replace Together.ai calls in eicore.ts education functions with Anthropic Claude Sonnet 4
- Target: zero TypeScript errors, clean build

**Deploy:**
- Create new Railway service from veloxsync-edu-api- repo
- Create new PostgreSQL instance on Railway (separate from main VeloxSync DB)
- Migrate 11 education-only tables to new DB:
  - classrooms, students, state_standards, curriculum_progress
  - learning_interventions, homeschool_children, behavior_logs
  - edu_documents, edu_subscriptions, edu_integrations, edu_oauth_sessions
- Add all env vars from .env.example to Railway
- Create new Vercel project from veloxsync-edu-web repo
- Set VITE_API_URL to new Railway backend URL

**Stripe setup for Education:**
- After Railway URL exists: add webhook endpoint in Stripe dashboard
- Point to: `veloxsync-edu-api-.up.railway.app/api/edu/billing/webhook`
- Copy signing secret to Railway as EDU_STRIPE_WEBHOOK_SECRET

**Google OAuth setup:**
- Add new Railway callback URL to Google Cloud Console

### Session 3 — Frontend Extraction + Landing Page
- Deploy `veloxsync_education.html` (built with real Cloudinary images) as the root `/` landing page
- Replace EduLanding.tsx with the new design
- Update all API calls in education pages to point to new backend URL
- Add Education-specific settings page (`/settings`) — standalone, not linking to main VeloxSync settings
- Add School vs Homeschool mode switcher for super admin
- Apply teal V2 design system to all education pages

### Session 4 — Cleanup + QA
- Remove education routes from main aetherflow-api (after confirming new API works)
- Remove education pages from main aetherflow-web (after confirming new frontend works)
- Remove student records from shared employees table (add WHERE student_role IS NULL to all HR queries permanently)
- Set up `education.veloxsync.app` subdomain on Vercel
- Full QA of both products independently
- FERPA compliance page
- Cookie banner on education site

---

## Roadmap — Demo Week (Next Week)

### VeloxSync HR Demo
**Script (8 stops, 2.5 minutes):**
1. Dashboard — KPI cards, At Risk list, Aaliyah Washington at 85%
2. Employee Profile — click Aaliyah, profile loads, Performance tab
3. Ei-Core Chat — "Who on my team needs attention this week?" — real names respond
4. Teams — 8 teams with real member counts
5. Org Chart — Tree view, Vivian Reyes at root
6. Pulse and Wellness — 30-day trend charts
7. Performance Reviews
8. Back to Dashboard — close on Ei-Core button

**Pre-recording checklist:**
- Together.ai endpoint awake at api.together.ai
- Ei-Core responds with Aaliyah Washington, Aisha Kamara, Kevin Hartman by name
- All 8 QA checks passing
- Chrome full screen, bookmarks bar hidden, no notifications

### VeloxSync Education Demo
**Script:** (build once education extraction is complete)

### Demo Page Build
After both videos recorded and uploaded to YouTube (unlisted):
- Build `/demo` page on veloxsync.app with YouTube embed + Storylane iframe
- Build `/demo` page on education.veloxsync.app with YouTube embed + Storylane iframe
- Storylane account: already created — record interactive click-through for both

---

## Roadmap — Near Term

### Bulma Pricing Page
- Update `veloxsync-pricing.html` (built in previous session) with V2 plan names and prices
- Correct prices: Spark $19, Momentum $35, Harmony $55, Ascent $95/seat
- Replace closing headline with "Your team is ready. Are you?"
- Add FAQ: "How long does setup take?"
- Deploy as `/pricing` route on veloxsync.app

### DaisyUI Kit Integration
- Add to Nail Check mobile UI (React + Capacitor)
- Add to Meraki Lingua widget interface
- Wire Meraki brand tokens: `--meraki-purple: #2D005E`, `--meraki-gold: #C8A96E`

### Bulma for Client Work
- Dr. Parker faith and finance WordPress theme
- Bishop Dingle GitHub page
- Future faith-based or client microsites (no React runtime needed)

---

## Roadmap — VeloxSync HR Remaining Fixes

### Known Issues (fix before enterprise demos)
- Teams show 0 members on team cards (display issue — member count query mismatch)
- Input fields on login still have light background (should be rgba(0,0,0,0.4))
- readiness_rating logic on POST /plans/:planId/candidates appears inverted
- Resend and Stripe constructed at module load in education-v2.ts and edu-billing.ts (cold restart risk — lazy instantiate)

### Features to Add
- `/demo` page with YouTube embed and Storylane iframe
- Register page V2 redesign (still old style)
- Team member count fix on Teams page cards

---

## Roadmap — Long Term

### VeloxSync Education — Fine-tuned Model
Once enough education interaction data exists:
- Fine-tune a Llama model on education-specific patterns
- Replace Claude Sonnet with proprietary Edu Catalyst model
- Same approach as the HR Ei-Core model

### VeloxSync Education — K12 Mode
- School vs Homeschool fully separated flows
- Teacher dashboard with class roster, department health, staff wellness
- Principal/admin view with campus intelligence feed
- Standalone `/education/settings` with education-specific preferences

### Security Hardening (pre-enterprise)
- Run security-tests.cjs and fix all failures
- Engage APIsec or similar for external audit before first $10k+ contract
- Add WHERE student_role IS NULL permanently to all HR queries
- SOC 2 Type II process (already in progress per VeloxSync whitepaper)

---

## Claude Code Session Rules

These apply to every session:

- PowerShell only — never chain commands with `&&` — run each separately
- All `@types/*` packages go in `dependencies` not `devDependencies`
- Node scripts use `.cjs` extension
- Backend build: `npx tsc`
- Frontend build check: `npx tsc --noEmit`
- File writes use `[System.IO.File]::WriteAllText` with UTF-8 no-BOM encoding
- Never use `git add -A` when `.claude/settings.local.json` would be included — stage specific files
- Always read the full codebase before making changes
- Confirm zero TypeScript errors before every push
- Push frontend and backend separately with clear commit messages

---

## Key File Locations

```
Frontend (HR):     C:\Users\mccla\aetherflow-web
Backend (HR):      C:\Users\mccla\OneDrive\Desktop\01_PROJECTS\FLOW\aetherflow-api
Frontend (Edu):    C:\Users\mccla\OneDrive\Desktop\01_PROJECTS\veloxsync-edu-web
Backend (Edu):     C:\Users\mccla\OneDrive\Desktop\01_PROJECTS\veloxsync-edu-api-
LTX clips:         C:\Users\mccla\OneDrive\Desktop\01_PROJECTS\VeloxSync\media\
Landing pages:     C:\Users\mccla\Downloads\veloxsync_v2.html
                   C:\Users\mccla\Downloads\veloxsync_education.html (if downloaded)
Education HTML:    Built and saved — veloxsync_education.html with real Cloudinary images
```

---

## Super Admin Credentials

- Org ID: `0c7bbd12-5021-4785-bb6b-bddae8531081`
- Email: `founder@adammcclarin.com`
- Together.ai model: `mcclarin96_c50a/Meta-Llama-3-8B-Instruct-90e7637c-0e0e23f2`

---

## Calendly
https://calendly.com/hello-merakislove/new-meeting

---

*This file lives in both the HR and Education repos. Update it at the end of every major session.*
