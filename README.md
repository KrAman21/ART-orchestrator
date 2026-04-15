We want to create an ART (Automated Regression Testing) workflow for Loan Marketplace Journey where we are trying to replay the PROD Scenario in our local env by mimicking the logic, configs, etc.
Loan Marketplace Flow: Merchant(Order Source) -> LSP (Core service of loan management) -> GW (Lender Integrations Gateway, gateway between LSP and Lenders) -> Lender (Lending Service)

Loan Flow should be:
APP <-> LSP <-> GW <-> LENDER

Our Architecture:
LSP <-> Orchestractor <-> GW

where 
- LSP and GW services are real services. 
- APP and LENDER will be mocked in Orchestrator
- Orchestrator should go through the logs in order (one by one).
- We need to replay the logs in sequence (might vary sequence in case of async API calls)
- LENDER->GW Webhook should be triggered from Orchestrator if explicitly Webhook log is present. Any LENDER->GW Webhook can be present at any time or step, Orchestrator should trigger that webhook as per log sequence.
- LENDER->GW should be responded as API response synchronously
- APP->LSP API Request should be triggered by Orchestrator
- Replay Flow
  - Request
    - If any request comes from LSP / GW service, then compare it with expected payload by finding log from logs.json matching (apiName, source, destination, loanApplicationId if exists, lenderOrgId if exists)
    - Stop the replay flow if mismatch happens
    - Call the Destination Service or Mock response if destination is "LENDER"
  - Response
    - First compare it with expected payload by finding log from logs.json matching (apiName, source, destination, loanApplicationId if exists, lenderOrgId if exists)
    - Respond to source service
- Defined the flow cases; you can refer following cases

## CASE 1 (APP<->LSP<->GW Sync call, Without LENDER Calls):
APP->LSP: API1 request (Orchestrator should trigger API1 call to LSP)
LSP->GW: API2 request (LSP will trigger API2 call to Orchestrator; then Orchestrator will forward API2 call to GW service)
GW->LSP: API2 response (GW will respond API2 call to Orchestrator; Eventually, Orchestrator should respond to LSP for API2 call)
LSP->APP: API1 response (Once received API2 response from Orchestrator; LSP will respond for API1 call to APP i.e. Orchestrator)

## CASE 2 (APP<->LSP<->GW<->LENDER Sync call, With SINGLE GW->LENDER Call in single LSP->GW Call):
APP->LSP: API1 request (Orchestrator should trigger API1 call to LSP)
LSP->GW: API2 request (LSP will trigger this API2 call to Orchestrator; then Orchestrator will forward this to GW service)
GW->LENDER: API3 request (GW will trigger this API3 call to Orchestrator)
LENDER->GW: API3 response (Orchestrator mock this response to GW)
GW->LSP: API2 response (Orchestrator should wait until intermediate GW->LENDER API3 call (request and response) completed, then GW will respond to Orchestrator; Eventually, Orchestrator should respond to LSP for API2 call)
LSP->APP: API1 response (Once received API2 response from Orchestrator; LSP will respond for API1 call to APP i.e. Orchestrator)

## CASE 3 (APP<->LSP<->GW<->LENDER Sync call, With Multiple GW->LENDER Calls in single LSP->GW Call):
APP->LSP: API1 request (Orchestrator should trigger API1 call to LSP)
LSP->GW: API2 request (LSP will trigger this API2 call to Orchestrator; then Orchestrator will forward this to GW service)
GW->LENDER: API3 request (GW will trigger this API3 call to Orchestrator)
LENDER->GW: API3 response (Orchestrator mock this API3 response to GW)
GW->LENDER: API4 request (GW will trigger this API4 call to Orchestrator)
LENDER->GW: API4 response (Orchestrator mock this API4 response to GW)
GW->LENDER: API5 request (GW will trigger this API5 call to Orchestrator)
LENDER->GW: API5 response (Orchestrator mock this API5 response to GW)
GW->LSP: API2 response (Orchestrator should wait until all the intermediate GW->LENDER (API3, API4, API5) calls completed, then GW will respond to Orchestrator; Eventually, Orchestrator should respond to LSP for API2 call)
LSP->APP: API1 response (Once received API2 response from Orchestrator; LSP will respond for API1 call to APP i.e. Orchestrator)

## CASE 4 (APP<->LSP<->GW<->LENDER Sync call, With Multiple LSP->GW Calls in single APP->LENDER Call):
APP->LSP: API1 request (Orchestrator should trigger API1 call to LSP)
LSP->GW: API2 request (LSP will trigger this API2 call to Orchestrator; then Orchestrator will forward this to GW service)
GW->LENDER: API3 request (GW will trigger this API3 call to Orchestrator)
LENDER->GW: API3 response (Orchestrator mock this API3 response to GW)
GW->LSP: API2 response (Orchestrator should wait until intermediate GW->LENDER API3 call completed, then GW will respond to Orchestrator; Eventually, Orchestrator should respond to LSP for API2 call)
LSP->GW: API4 request (LSP will trigger this API4 call to Orchestrator; then Orchestrator will forward this to GW service)
GW->LENDER: API5 request (GW will trigger this API5 call to Orchestrator)
LENDER->GW: API5 response (Orchestrator mock this API5 response to GW)
GW->LSP: API4 response (Orchestrator should wait until intermediate GW->LENDER API5 call completed, then GW will respond to Orchestrator; Eventually, Orchestrator should respond to LSP for API4 call)
LSP->APP: API1 response (Once received API2 and API4 response from Orchestrator; LSP will respond for API1 call to APP i.e. Orchestrator)

## CASE 5 (With APP->LSP async call, and LSP->GW sync call):
APP->LSP: API1 async request (Orchestrator should trigger API1 call to LSP)
LSP->APP: API1 response / ack (LSP will respond for API1 call to APP i.e. Orchestrator)
LSP->GW: API2 request (LSP will trigger this API2 call to Orchestrator; then Orchestrator will forward this to GW service)
GW->LENDER: API3 request (GW will trigger this API3 call to Orchestrator)
LENDER->GW: API3 response (Orchestrator mock this API3 response to GW)
GW->LSP: API2 response (Orchestrator should wait until intermediate GW->LENDER API3 call completed, then GW will respond to Orchestrator; Eventually, Orchestrator should respond to LSP for API2 call)
APP->LSP: API4 request (Orchestrator should trigger API4 call to LSP)
LSP->APP: API4 repsonse (LSP processes the request, then LSP responds to Orchestrator for API4 call)

## CASE 6 (APP<->LSP<->GW<->LENDER Sync call, With LENDER Webhook):
APP->LSP: API1 request (Orchestrator should trigger API1 call to LSP)
LSP->GW: API2 request (LSP will trigger this API2 call to Orchestrator; then Orchestrator will forward this to GW service)
GW->LENDER: API3 request (GW will trigger this API3 call to Orchestrator)
LENDER->GW: Webhook (Orchestrator should trigger a webhook to GW, before responding to API3 request)
LENDER->GW: API3 response (Orchestrator mock this API3 response to GW)
GW->LSP: API2 response (Orchestrator should wait until intermediate GW->LENDER API3 call completed, then GW will respond to Orchestrator; Eventually, Orchestrator should respond to LSP for API2 call)
LSP->APP: API1 response (Once received API2 response from Orchestrator; LSP will respond for API1 call to APP i.e. Orchestrator)

## CASE 7 (APP<->LSP<->GW<->LENDER Sync call, With LENDER Webhook):
APP->LSP: API1 request (Orchestrator should trigger API1 call to LSP)
LSP->GW: API2 request (LSP will trigger this API2 call to Orchestrator; then Orchestrator will forward this to GW service)
GW->LENDER: API3 request (GW will trigger this API3 call to Orchestrator)
LENDER->GW: API3 response (Orchestrator mock this API3 response to GW)
LENDER->GW: Webhook (Orchestrator should trigger a webhook to GW, after responding to API3 request)
GW->LSP: API2 response (Orchestrator should wait until intermediate GW->LENDER API3 call completed and webhook is triggered, then GW will respond to Orchestrator; Eventually, Orchestrator should respond to LSP for API2 call)
LSP->APP: API1 response (Once received API2 response from Orchestrator; LSP will respond for API1 call to APP i.e. Orchestrator)

- Check with current implementation if it is implementated as expected as above. Ask anything if you need clarity or suggest anything if required.