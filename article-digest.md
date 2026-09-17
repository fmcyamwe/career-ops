# Article Digest -- Proof Points

Compact proof points from portfolio projects. Read by career-ops at evaluation time.

---

## GreatIam -- Android mobile application

**Hero metrics:** Designed, developed, deployed an Android application

**Architecture:** Golang backend → JWT tokens for authentication → WebSockets for real time chats →  Neo4 graph database → Kotlin, Jetpack Compose UI → language translation → Firebase Cloud Messaging → AWS services

**Key decisions:**
- Deployed using Docker containers via AWS services.
- App architecture and design with multiple languages and timezones in mind 
- Real-time chat via WebSockets and user authentication with JSON web tokens 
- Neo4j Graph database.

**Proof points:**
- Increased knowledge of mobile development with Kotlin and Jetpack compose
- Language translation per chat per user
- Design tradeoffs with increase knowledge of deployment and network topology needs of a web application
- Expertise in Neo4j Graph database.

---

## GPlanner -- Web application

**Hero metrics:** Designed, developed, deployed an Android application 99., 50ms p99 latency, $2M/year fraud prevented

**Architecture:** Kafka Streams ingestion → real-time feature computation (200+ features, sliding windows) → ensemble model (XGBoost + neural network) → decision engine with configurable thresholds → human review queue for edge cases

**Key decisions:**
- Chose streaming over batch to catch fraud in real-time (batch had 4-hour delay)
- Ensemble approach: XGBoost for speed + neural net for complex patterns
- Built custom feature store for real-time features (Redis-backed, 5ms reads)

**Proof points:**
- Reduced false positives 60% vs previous rule-based system
- Handles 10K transactions/second peak load
- 500+ GitHub stars, adopted by 3 fintech startups
- Conference talk: "Real-Time ML at Scale" (MLConf 2023)

---

## Machine learning model Evaluation -- Image moderation 

**Hero metrics:** 15 built-in metrics, CI/CD integration, used by 200+ developers

**Architecture:** Pluggable metric system → test suite runner → regression detection → GitHub Actions integration → Slack alerts on regressions

**Key decisions:**
- Metrics as code: each metric is a Python function with clear interface
- Deterministic testing: seeded prompts + temperature 0 for reproducible evals
- Cost tracking: each eval run logs token usage and estimated cost

**Proof points:**
- Caught 3 production regressions before deployment in first month
- Reduced eval cycle from "vibes check" to structured 15-minute CI run
- Open source, 200+ weekly active users on PyPI

---

## KLaw gen -- AI agent legal assistant app

**Hero metrics:** 15 built-in metrics, CI/CD integration, used by 200+ developers

**Architecture:** Pluggable metric system → test suite runner → regression detection → GitHub Actions integration → Slack alerts on regressions

**Key decisions:**
- Metrics as code: each metric is a Python function with clear interface
- Deterministic testing: seeded prompts + temperature 0 for reproducible evals
- Cost tracking: each eval run logs token usage and estimated cost

**Proof points:**
- Caught 3 production regressions before deployment in first month
- Reduced eval cycle from "vibes check" to structured 15-minute CI run
- Open source, 200+ weekly active users on PyPI