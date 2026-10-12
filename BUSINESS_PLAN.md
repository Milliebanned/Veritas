# Veritas business plan

Built with [cfo.ai](https://cfo.ai) on October 12, 2026. The model is public here:
**https://cfo.ai/s/R5-5UDJk4xc5TlZQ**

Veritas is sold to JavaScript and TypeScript teams as a subscription. It checks a repository's npm
dependencies, proves which upgrades break the code by running the project's own tests, writes a
tested fix, and opens a pull request once a person approves.

## The short version

| | First plan | Revised plan |
| --- | --- | --- |
| Team price | $49 a month | $99 a month |
| Business price | $199 a month | $399 a month |
| Free plan | 5 investigations a day | 5 investigations a month |
| Gross margin, Team / Business | 47% / 35% | 74% / 68% |
| Free usage paid for by each customer | $120 a month | $4.50 a month |
| First profitable month | never, within 12 months | month 2 |
| Runway from $10,000 | 7.2 months | more than 12 months |
| Cash after 12 months | −$25,153 | $5,033 |

The first plan was ours. cfo.ai showed it loses money on every customer, and the revised plan is
the result. Both are kept in the model as separate scenarios.

## What the numbers are based on

Measured, from the benchmark in [evidence/bench/](evidence/bench/):

- Model cost per investigation: **$0.09** on average across nine repositories on a small model.
- An investigation that includes a code repair costs $0.10 to $0.18.
- One server (AWS t3.large) is about $60 a month.

Assumed, and not yet proven:

- Paying customers run on a stronger model at $0.60 per investigation.
- Each connected repository is investigated once a week.
- Three paying design partners in month 1, 25% new customers a month, 3% leaving.
- One Business customer for every six Team customers.
- Ten free users for every paying customer.
- Fixed costs of $250 a month (infrastructure and tools). Starting cash of $10,000.

Nobody has paid for Veritas yet. The prices are hypotheses.

## Why the first plan failed

The free plan allowed five investigations a day on the same expensive model as paying customers.
With ten free users per customer, each using about twenty investigations a month, every paying
customer carried **$120 a month** of free usage.

| Per customer, per month | Revenue | Model cost | Share of free usage | Left over |
| --- | --- | --- | --- | --- |
| Team at $49 | $49.00 | $25.80 | $120.00 | −$96.80 |
| Business at $199 | $199.00 | $129.00 | $120.00 | −$50.00 |

Every new customer made the loss bigger, so growth could not fix it. Cash ran out in month 8,
soon after the founder salary started.

## The revised plan

| Plan | Price | Repositories | Investigations included | Extra investigations |
| --- | --- | --- | --- | --- |
| Free | $0 | Public only | 5 a month per user | Not available |
| Team | $99 a month | Up to 10 private | 43 a month | $1.50 each, opt-in |
| Business | $399 a month | Up to 50, priority runs | 215 a month | $1.50 each, opt-in |

Three changes:

1. **The free plan is capped and runs on the small model.** Five investigations a month at the
   measured $0.09 is $0.45 per free user, or $4.50 per paying customer.
2. **Prices doubled, with a fixed number of investigations per plan.** Repairs and retries count
   against the same budget. A run past the budget needs explicit approval; otherwise it stops.
3. **The founder is paid only when cash allows.** $3,000 is paid in a month only if cash stays
   above $5,000 afterwards.

| Per customer, per month | Revenue | Model cost | Share of free usage | Left over |
| --- | --- | --- | --- | --- |
| Team at $99 | $99.00 | $25.80 | $4.50 | $68.70 |
| Business at $399 | $399.00 | $129.00 | $4.50 | $265.50 |

## Twelve months, revised plan

October 2026 to September 2027, in US dollars. Costs include the founder salary in the months it is paid.

| Month | Revenue | Costs | Profit | Salary paid |
| --- | --- | --- | --- | --- |
| 1 | $426 | $3,385 | −$2,960 | yes |
| 2 | $519 | $415 | $104 | |
| 3 | $633 | $451 | $182 | |
| 4 | $773 | $495 | $277 | |
| 5 | $943 | $549 | $393 | |
| 6 | $1,150 | $3,615 | −$2,465 | yes |
| 7 | $1,403 | $696 | $708 | |
| 8 | $1,712 | $794 | $918 | |
| 9 | $2,089 | $3,913 | −$1,825 | yes |
| 10 | $2,548 | $1,059 | $1,489 | |
| 11 | $3,109 | $4,237 | −$1,128 | yes |
| 12 | $3,793 | $4,454 | −$662 | yes |
| **Total** | **$19,097** | **$24,064** | **−$4,967** | **$15,000** |

- The business is profitable before founder pay from month 1.
- Month 2 is the first profitable month. It is not yet sustained: months with a salary payment still lose money.
- Cash never runs out in the twelve months and ends at $5,033.

## What is still weak

- **The founder cannot be paid every month.** The salary rule allows five payments in twelve
  months. A steady $3,000 a month is not supported within this forecast.
- **The cash cushion is thin.** The lowest month-end balance is $33 above the $5,000 floor.
- **Willingness to pay is untested.** $99 and $399 are hypotheses, and no overage sales are assumed.
- **Some costs are left out.** Test-execution compute beyond the server allowance, support,
  payment fees and taxes are not in the model and would all make it worse.
- **The $0.60 cost on a stronger model is an estimate.** The benchmark has only been scored on
  the small model. The first plan breaks even on usage only below about $0.26 per investigation,
  so this number matters more than any other.

## What we do next

1. Sign three design partners at the revised prices before building anything else for sale.
2. Score the benchmark on the stronger model to replace the $0.60 estimate with a measured cost.
3. Add sandbox compute and payment fees to the model before treating the $5,000 floor as safe.

## Evidence

- The cfo.ai model: https://cfo.ai/s/R5-5UDJk4xc5TlZQ
- cfo.ai's finding on the first plan: [evidence/cfo/1-base-case-no-break-even.png](evidence/cfo/1-base-case-no-break-even.png)
- cfo.ai's full answer on the revised plan: [evidence/cfo/ari-revised-case.md](evidence/cfo/ari-revised-case.md)
