import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const lendersData = JSON.parse(readFileSync(join(__dirname, 'data', 'lenders.json'), 'utf-8'));

export const LENDER_ORG_ID_TO_ID_MAP = Object.freeze(
  Object.fromEntries(lendersData.map(l => [l.org_id, l.id]))
);

export function getLenderId(orgId) {
  return LENDER_ORG_ID_TO_ID_MAP[orgId] || null;
}

// Service configuration mappings
export const SERVICE_MAP = {
  LSP: { baseUrl: process.env.LSP_URL || 'http://localhost:4232', name: 'LSP' },
  GW: { baseUrl: process.env.GW_URL || 'http://localhost:2344', name: 'Gateway' }
};

// API endpoint mapping based on (sourceDestination, logTag) combination
// Key format: "sourceDestination|logTag" where sourceDestination is "SOURCE_DEST"
// Optional headers field for custom headers per endpoint
export const API_TO_ENDPOINT_MAP = {
  // ==================== APP_WRAPPER (Wrapper Endpoints - Incoming from APP) ====================
  // FlipKart APIs
  'APP_WRAPPER|FlipKart-Eligibility_INCOMING': { endpoint: '/flipkart/eligibility', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-EligibilityStatus_INCOMING': { endpoint: '/flipkart/eligibility/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-HardEligibility_INCOMING': { endpoint: '/flipkart/eligibility/lender', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-HardEligibilityStatus_INCOMING': { endpoint: '/flipkart/eligibility/lender/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-GetKFS_INCOMING': { endpoint: '/flipkart/getKFS', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-GetRedirectionURL_INCOMING': { endpoint: '/flipkart/getRedirectionUrl', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-InitaiteTxn_INCOMING': { endpoint: '/flipkart/txns', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-OrderStatus_INCOMING': { endpoint: '/flipkart/order/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-Refund_INCOMING': { endpoint: '/flipkart/refund', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-FetchStatus_INCOMING': { endpoint: '/flipkart/fetch/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-CreateLoan_INCOMING': { endpoint: '/flipkart/createLoan', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  
  // FlipKart Line Onboarding APIs
  'APP_WRAPPER|FlipKart-LineOnboarding-Eligibility_INCOMING': { endpoint: '/flipkart/initiate/line/eligibility', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-EligibilityStatus_INCOMING': { endpoint: '/flipkart/initiate/line/eligibility/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibility_INCOMING': { endpoint: '/flipkart/line/eligibility/lender', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibilityStatus_INCOMING': { endpoint: '/flipkart/line/eligibility/lender/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetRedirectionURL_INCOMING': { endpoint: '/flipkart/line/getRedirectionUrl', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetKFS_INCOMING': { endpoint: '/flipkart/line/getKFS', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-LineStatus_INCOMING': { endpoint: '/flipkart/customer/line/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-FetchLineStatus_INCOMING': { endpoint: '/flipkart/fetch/line/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-RealTimeEligibility_INCOMING': { endpoint: '/flipkart/txn/eligibility/line', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  
  // FlipKart 2W APIs
  'APP_WRAPPER|Flipkart2W-Eligibility_INCOMING': { endpoint: '/flipkart2w/eligibility', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|Flipkart2W-EligibilityStatus_INCOMING': { endpoint: '/flipkart2w/eligibility/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-2W-HardEligibility_INCOMING': { endpoint: '/flipkart2w/eligibility/lender', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart2W-HardEligibilityStatus_INCOMING': { endpoint: '/flipkart2w/eligibility/lender/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-GetKFS_INCOMING': { endpoint: '/flipkart2w/getKFS', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-2W_INCOMING': { endpoint: '/flipkart2w/getRedirectionUrl', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart2W-InitaiteTxn_INCOMING': { endpoint: '/flipkart2w/txns', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart2W-Refund_INCOMING': { endpoint: '/flipkart2w/refund', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart2W-FetchStatus_INCOMING': { endpoint: '/flipkart2w/fetch/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart2W-CreateLoan_INCOMING': { endpoint: '/flipkart2w/createLoan', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart2W-CreatePayment_INCOMING': { endpoint: '/flipkart2w/dp/create', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart2W-CustomerStatus_INCOMING': { endpoint: '/flipkart2w/customer/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  
  // Juspay SDK APIs
  'APP_WRAPPER|JuspaySDK-SoftEligiblity_INCOMING': { endpoint: '/sdk/eligibility', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetOffers_INCOMING': { endpoint: '/sdk/offers/get', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GenerateOffers_INCOMING': { endpoint: '/sdk/offers/generate', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOffer-HardEligibility_INCOMING': { endpoint: '/sdk/fetchOffer', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOfferStatus-HardEligibility-SDK_INCOMING': { endpoint: '/sdk/fetchOfferStatus', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-CreateLoanApplication_INCOMING': { endpoint: '/sdk/createLoanApplication', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-SetOffer_INCOMING': { endpoint: '/sdk/offer/set', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetJourneyUrl_INCOMING': { endpoint: '/sdk/journey/url/get', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|GetFlowLink-SDK_INCOMING': { endpoint: '/sdk/getFlowLink', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-ResumeJourney_INCOMING': { endpoint: '/sdk/journey/resume', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-TriggerOTP_INCOMING': { endpoint: '/sdk/otp/trigger', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-VerifyLspOtp_INCOMING': { endpoint: '/sdk/verifyLspOtp', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TriggerActionRequired_INCOMING': { endpoint: '/sdk/actionRequired/trigger', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetKFS_INCOMING': { endpoint: '/sdk/getKFS', method: 'POST', service: 'LSP', headers: {} },
  
  // Business Loan APIs
  'APP_WRAPPER|JuspaySDK-SoftEligiblity_INCOMING_businessloan': { endpoint: '/businessloan/eligibility/soft', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOffer-HardEligibility_INCOMING_bl': { endpoint: '/businessloan/eligibility/hard', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOfferStatus-HardEligibility-SDK_INCOMING_bl': { endpoint: '/businessloan/eligibility/hard/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-CreateUpdateCustomer_INCOMING': { endpoint: '/businessloan/customer', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetCustomer_INCOMING': { endpoint: '/businessloan/customer/get', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetLink_INCOMING': { endpoint: '/businessloan/link/get', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-VerifyAuth_INCOMING': { endpoint: '/businessloan/auth/verify', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetLoanIntentStatus_INCOMING': { endpoint: '/businessloan/loanIntent/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetLoanApplicationStatus_INCOMING': { endpoint: '/businessloan/loanApplication/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetKFS_INCOMING': { endpoint: '/businessloan/getKFS', method: 'POST', service: 'LSP', headers: {} },
  
  // TSP HyperCredit APIs
  'APP_WRAPPER|TSP-Hypercredit-Eligibility_INCOMING': { endpoint: '/tsp/eligibility', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-Hypercredit-OrderCreate_INCOMING': { endpoint: '/tsp/order/create', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-Hypercredit-OrderStatus_INCOMING': { endpoint: '/tsp/order/:orderId', method: 'GET', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-HyperCredit-Refund_INCOMING': { endpoint: '/tsp/refund', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-HyperCredit-Capture_INCOMING': { endpoint: '/tsp/capture', method: 'POST', service: 'LSP', headers: {} },
  
  // Generic Wrapper APIs
  'APP_WRAPPER|Generics-Eligibility_INCOMING': { endpoint: '/api/eligibility', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetKFS_INCOMING_generic': { endpoint: '/api/getKFS', method: 'POST', service: 'LSP', headers: {} },
  
  // ==================== APP_CORE (Direct App to Core Endpoints) ====================
  'APP_CORE|LSP-LoanStatus_INCOMING': { endpoint: '/api/v3.3/loanStatus', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GrantLoanRequest_INCOMING': { endpoint: '/api/v3.3/grantLoan', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetFlowLink_INCOMING': { endpoint: '/api/v5.0/getLenderFlows', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetCustomerInfo_INCOMING': { endpoint: '/api/v4.0/customer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-UpdateCustomerInfo_INCOMING': { endpoint: '/api/v4.0/updateCustomer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerLspOtp_INCOMING': { endpoint: '/api/v4.0/triggerLspOtp', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-VerifyLspOtp_INCOMING': { endpoint: '/api/v4.0/verifyLspOtp', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-PriorityLogic_INCOMING': { endpoint: '/api/v5.0/priorityLogic', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerDisbursementAuth_INCOMING': { endpoint: '/api/v3.3/triggerDisbursement', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-CLAStatus_INCOMING': { endpoint: '/api/v3.3/claStatus', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerKYCRequestV5_INCOMING': { endpoint: '/api/v5.0/triggerKyc', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-StatusKYCFlowRequestV5_INCOMING': { endpoint: '/api/v5.0/statusKyc', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerDownPaymentModRequest_INCOMING': { endpoint: '/api/v5.0/downpayment/trigger', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-StatusDownPaymentModRequest_INCOMING': { endpoint: '/api/v5.0/downpayment/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerRepaymentModRequest_INCOMING': { endpoint: '/api/v5.0/repayment/trigger', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetRepaymentStatus_INCOMING': { endpoint: '/api/v5.0/repayment/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerLoanAgreement_INCOMING': { endpoint: '/api/v5.0/loanAgreement/trigger', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetLoanAgreementStatus_INCOMING': { endpoint: '/api/v5.0/loanAgreement/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-SetOffer_INCOMING': { endpoint: '/api/v5.0/setOffer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GenerateOffers_INCOMING': { endpoint: '/api/v4.0/generateOffers', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-FetchOfferResponse_INCOMING': { endpoint: '/api/v4.0/fetchOfferResponse', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-LoanAgreementStatus_INCOMING': { endpoint: '/api/v3.3/loanAgreementStatus', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetAgreementDataResponse_INCOMING': { endpoint: '/api/v3.3/getAgreementData', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-LoanSummary_INCOMING': { endpoint: '/api/v3.3/loanSummary', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-LoanStatementAccount_INCOMING': { endpoint: '/api/v3.3/loanStatement', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GenerateQR_INCOMING': { endpoint: '/api/v1.0/qr/generate', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-CreateCustomer_INCOMING': { endpoint: '/api/v5.0/createCustomer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-RaiseTicket_INCOMING': { endpoint: '/api/v5.0/ticket/raise', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-ListTicket_INCOMING': { endpoint: '/api/v5.0/ticket/list', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-VerifyCustomer_INCOMING': { endpoint: '/api/v3.3/verifyCustomer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-Rules_INCOMING': { endpoint: '/api/themis/rules', method: 'POST', service: 'LSP', headers: {} },
  
  // ==================== CORE_GATEWAY (Core to Gateway/Lender - Outgoing) ====================
  'CORE_GATEWAY|LSP-Eligibility_OUTGOING': { endpoint: '/gateway/v1.0/eligibility', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-SelectOffer_OUTGOING': { endpoint: '/gateway/v1.0/selectOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreatePayment_OUTGOING': { endpoint: '/gateway/v1.0/createPayment', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateOrder_OUTGOING': { endpoint: '/gateway/v1.0/order', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-RefundTriggerV2_OUTGOING': { endpoint: '/gateway/v1.0/refund', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-RefundStatusV2_OUTGOING': { endpoint: '/gateway/v1.0/refundStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-GrantLoanRequest_OUTGOING': { endpoint: '/gateway/v1.0/grantLoan', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TriggerDisbursementAuth_OUTGOING': { endpoint: '/gateway/v1.0/disbursement/trigger', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchOfferRequest_OUTGOING': { endpoint: '/gateway/v1.0/fetchOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchOfferStatus_OUTGOING': { endpoint: '/gateway/v1.0/fetchOfferStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TxnIntent_OUTGOING': { endpoint: '/gateway/v1.0/txnIntent', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TxnIntentStatus_OUTGOING': { endpoint: '/gateway/v1.0/txnIntentStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TxnIntentUpdate_OUTGOING': { endpoint: '/gateway/v1.0/txnIntentUpdate', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchState_OUTGOING': { endpoint: '/gateway/v1.0/fetchState', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-LoanApplicationStatus_OUTGOING': { endpoint: '/gateway/v1.0/loanApplicationStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateLoanApplication_OUTGOING': { endpoint: '/gateway/v1.0/createLoanApplication', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateLoanRequestInfo_OUTGOING': { endpoint: '/gateway/v1.0/createLoanRequestInfo', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-UpdateLoanRequestInfo_OUTGOING': { endpoint: '/gateway/v1.0/updateLoanRequestInfo', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateOffer_OUTGOING': { endpoint: '/gateway/v1.0/createOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-GetKFS_OUTGOING': { endpoint: '/gateway/v1.0/getKFS', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-HardEligibility_OUTGOING': { endpoint: '/gateway/v1.0/hardEligibility', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchOfferSync_OUTGOING': { endpoint: '/gateway/v1.0/fetchOfferSync', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TriggerActionRequired_OUTGOING': { endpoint: '/gateway/v1.0/triggerActionRequired', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-ActionRequiredStatus_OUTGOING': { endpoint: '/gateway/v1.0/actionRequiredStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-BackRedirection_OUTGOING': { endpoint: '/gateway/v1.0/backRedirection', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateUpdateCustomer_OUTGOING': { endpoint: '/gateway/v1.0/customer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateUpdateApplicant_OUTGOING': { endpoint: '/gateway/v1.0/applicant', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateUpdateGuarantor_OUTGOING': { endpoint: '/gateway/v1.0/guarantor', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-GetCustomer_OUTGOING': { endpoint: '/gateway/v1.0/getCustomer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-GetApplicant_OUTGOING': { endpoint: '/gateway/v1.0/getApplicant', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-GetGuarantor_OUTGOING': { endpoint: '/gateway/v1.0/getGuarantor', method: 'POST', service: 'GW', headers: {} },
  
  // ==================== GATEWAY_CORE (Gateway to Core - Responses/Callbacks) ====================
  'GATEWAY_CORE|LSP-Eligibility_INCOMING': { endpoint: '/v1/themis/eligibility/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|LSP-GrantLoanRequest_INCOMING': { endpoint: '/v1/themis/grantLoan/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|LSP-TriggerDisbursementAuth_INCOMING': { endpoint: '/v1/themis/disbursement/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|Eligibility Response': { endpoint: '/v1/themis/gateway/response', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|LoanStatus Response': { endpoint: '/v1/themis/loanStatus/response', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|Disbursement Response': { endpoint: '/v1/themis/disbursement/response', method: 'POST', service: 'LSP', headers: {} },
  
  // ==================== CORE_THEMIS (Core to Themis) ====================
  'CORE_THEMIS|Themis-Eligibility Request': { endpoint: '/themis/v5/sortLenders', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-PriorityLogic Request': { endpoint: '/themis/v5/priorityLogic', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-GetBreRules Request': { endpoint: '/themis/v5/breRules', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-VerifyLspOtp Request': { endpoint: '/themis/v5/verifyOtp', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-TriggerLspOtp Request': { endpoint: '/themis/v5/triggerOtp', method: 'POST', service: 'THEMIS', headers: {} },
  
  // ==================== CORE_APP (Core to App - Responses/Callbacks) ====================
  'CORE_APP|LSP-Eligibility_OUTGOING': { endpoint: '/v1/lsp/eligibility/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-LoanStatus_OUTGOING': { endpoint: '/v1/lsp/loanStatus/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-Callback Response': { endpoint: '/webhook/lsp/callback', method: 'POST', service: 'APP', headers: {} },
  
  // ==================== GATEWAY_LENDER (Gateway to Lender - Lender Side) ====================
  'GATEWAY_LENDER|Themis-Eligibility Request': { endpoint: '/lsp/softEligibility', method: 'POST', service: 'GATEWAY', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibility Request': { endpoint: '/lsp/hardEligibility', method: 'POST', service: 'GATEWAY', headers: {} },
  'GATEWAY_LENDER|Themis-GrantLoan Request': { endpoint: '/lsp/grantLoan', method: 'POST', service: 'GATEWAY', headers: {} },
  'GATEWAY_LENDER|Themis-Disbursement Request': { endpoint: '/lsp/disbursement', method: 'POST', service: 'GATEWAY', headers: {} },
  'GATEWAY_LENDER|Themis-FetchOffer Request': { endpoint: '/lsp/fetchOffer', method: 'POST', service: 'GATEWAY', headers: {} },
  'GATEWAY_LENDER|Themis-SelectOffer Request': { endpoint: '/lsp/selectOffer', method: 'POST', service: 'GATEWAY', headers: {} },
  'GATEWAY_LENDER|Themis-KYC Request': { endpoint: '/lsp/kyc', method: 'POST', service: 'GATEWAY', headers: {} },
  'GATEWAY_LENDER|Themis-Repayment Request': { endpoint: '/lsp/repayment', method: 'POST', service: 'GATEWAY', headers: {} },
  
  // ==================== LENDER_GATEWAY (Lender to Gateway - Callbacks/Webhooks) ====================
  'LENDER_GATEWAY|WEBHOOK Request': { endpoint: '/gateway/webhook', method: 'POST', service: 'GATEWAY', headers: {} },
  'LENDER_GATEWAY|Themis-Eligibility Response': { endpoint: '/v1/themis/gateway/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-GrantLoan Response': { endpoint: '/v1/themis/grantLoan/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-Disbursement Response': { endpoint: '/v1/themis/disbursement/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-FetchOffer Response': { endpoint: '/v1/themis/fetchOffer/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-KYC Response': { endpoint: '/v1/themis/kyc/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-Repayment Response': { endpoint: '/v1/themis/repayment/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|ThemisGenerateOffersResponse Response': { endpoint: '/v1/themis/offers/response', method: 'POST', service: 'GW', headers: {} }
};

// API endpoint mapping: endpoint -> { logTag, api, sourceDestination, headers }
export const API_TO_LOGTAG_MAP = {
  // ==================== APP_WRAPPER (Wrapper Endpoints - Incoming from APP) ====================
  // FlipKart APIs
  '/flipkart/eligibility': { logTag: 'FlipKart-Eligibility_INCOMING', api: '/flipkart/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/status': { logTag: 'FlipKart-EligibilityStatus_INCOMING', api: '/flipkart/eligibility/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/lender': { logTag: 'FlipKart-HardEligibility_INCOMING', api: '/flipkart/eligibility/lender', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/lender/status': { logTag: 'FlipKart-HardEligibilityStatus_INCOMING', api: '/flipkart/eligibility/lender/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/getKFS': { logTag: 'FlipKart-GetKFS_INCOMING', api: '/flipkart/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/getRedirectionUrl': { logTag: 'FlipKart-GetRedirectionURL_INCOMING', api: '/flipkart/getRedirectionUrl', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/txns': { logTag: 'FlipKart-InitaiteTxn_INCOMING', api: '/flipkart/txns', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/order/status': { logTag: 'FlipKart-OrderStatus_INCOMING', api: '/flipkart/order/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/refund': { logTag: 'FlipKart-Refund_INCOMING', api: '/flipkart/refund', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/fetch/status': { logTag: 'FlipKart-FetchStatus_INCOMING', api: '/flipkart/fetch/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/createLoan': { logTag: 'FlipKart-CreateLoan_INCOMING', api: '/flipkart/createLoan', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // FlipKart Line Onboarding APIs
  '/flipkart/initiate/line/eligibility': { logTag: 'FlipKart-LineOnboarding-Eligibility_INCOMING', api: '/flipkart/initiate/line/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/initiate/line/eligibility/status': { logTag: 'FlipKart-LineOnboarding-EligibilityStatus_INCOMING', api: '/flipkart/initiate/line/eligibility/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/eligibility/lender': { logTag: 'FlipKart-LineOnboarding-HardEligibility_INCOMING', api: '/flipkart/line/eligibility/lender', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/eligibility/lender/status': { logTag: 'FlipKart-LineOnboarding-HardEligibilityStatus_INCOMING', api: '/flipkart/line/eligibility/lender/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/getRedirectionUrl': { logTag: 'FlipKart-LineOnboarding-GetRedirectionURL_INCOMING', api: '/flipkart/line/getRedirectionUrl', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/getKFS': { logTag: 'FlipKart-LineOnboarding-GetKFS_INCOMING', api: '/flipkart/line/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/customer/line/status': { logTag: 'FlipKart-LineOnboarding-LineStatus_INCOMING', api: '/flipkart/customer/line/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/fetch/line/status': { logTag: 'FlipKart-LineOnboarding-FetchLineStatus_INCOMING', api: '/flipkart/fetch/line/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/txn/eligibility/line': { logTag: 'FlipKart-RealTimeEligibility_INCOMING', api: '/flipkart/txn/eligibility/line', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // FlipKart 2W APIs
  '/flipkart2w/eligibility': { logTag: 'FlipKart2W-Eligibility_INCOMING', api: '/flipkart2w/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/eligibility/status': { logTag: 'FlipKart2W-EligibilityStatus_INCOMING', api: '/flipkart2w/eligibility/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/eligibility/lender': { logTag: 'FlipKart-2W-HardEligibility_INCOMING', api: '/flipkart2w/eligibility/lender', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/eligibility/lender/status': { logTag: 'FlipKart2W-HardEligibilityStatus_INCOMING', api: '/flipkart2w/eligibility/lender/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/getKFS': { logTag: 'FlipKart-GetKFS_INCOMING', api: '/flipkart2w/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/getRedirectionUrl': { logTag: 'FlipKart-2W_INCOMING', api: '/flipkart2w/getRedirectionUrl', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/txns': { logTag: 'FlipKart2W-InitaiteTxn_INCOMING', api: '/flipkart2w/txns', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/refund': { logTag: 'FlipKart2W-Refund_INCOMING', api: '/flipkart2w/refund', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/fetch/status': { logTag: 'FlipKart2W-FetchStatus_INCOMING', api: '/flipkart2w/fetch/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/createLoan': { logTag: 'FlipKart2W-CreateLoan_INCOMING', api: '/flipkart2w/createLoan', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/dp/create': { logTag: 'FlipKart2W-CreatePayment_INCOMING', api: '/flipkart2w/dp/create', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/customer/status': { logTag: 'FlipKart2W-CustomerStatus_INCOMING', api: '/flipkart2w/customer/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // Juspay SDK APIs
  '/sdk/eligibility': { logTag: 'JuspaySDK-SoftEligiblity_INCOMING', api: '/sdk/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/offers/get': { logTag: 'JuspaySDK-GetOffers_INCOMING', api: '/sdk/offers/get', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/offers/generate': { logTag: 'JuspaySDK-GenerateOffers_INCOMING', api: '/sdk/offers/generate', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/fetchOffer': { logTag: 'JuspaySDK-FetchOffer-HardEligibility_INCOMING', api: '/sdk/fetchOffer', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/fetchOfferStatus': { logTag: 'JuspaySDK-FetchOfferStatus-HardEligibility-SDK_INCOMING', api: '/sdk/fetchOfferStatus', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/createLoanApplication': { logTag: 'JuspaySDK-CreateLoanApplication_INCOMING', api: '/sdk/createLoanApplication', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/offer/set': { logTag: 'JuspaySDK-SetOffer_INCOMING', api: '/sdk/offer/set', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/journey/url/get': { logTag: 'JuspaySDK-GetJourneyUrl_INCOMING', api: '/sdk/journey/url/get', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/getFlowLink': { logTag: 'GetFlowLink-SDK_INCOMING', api: '/sdk/getFlowLink', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/journey/resume': { logTag: 'JuspaySDK-ResumeJourney_INCOMING', api: '/sdk/journey/resume', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/otp/trigger': { logTag: 'JuspaySDK-TriggerOTP_INCOMING', api: '/sdk/otp/trigger', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/verifyLspOtp': { logTag: 'JuspaySDK-VerifyLspOtp_INCOMING', api: '/sdk/verifyLspOtp', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/actionRequired/trigger': { logTag: 'TriggerActionRequired_INCOMING', api: '/sdk/actionRequired/trigger', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/getKFS': { logTag: 'JuspaySDK-GetKFS_INCOMING', api: '/sdk/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // Business Loan APIs
  '/businessloan/eligibility/soft': { logTag: 'JuspaySDK-SoftEligiblity_INCOMING_businessloan', api: '/businessloan/eligibility/soft', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/eligibility/hard': { logTag: 'JuspaySDK-FetchOffer-HardEligibility_INCOMING_bl', api: '/businessloan/eligibility/hard', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/eligibility/hard/status': { logTag: 'JuspaySDK-FetchOfferStatus-HardEligibility-SDK_INCOMING_bl', api: '/businessloan/eligibility/hard/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/customer': { logTag: 'BusinessLoan-CreateUpdateCustomer_INCOMING', api: '/businessloan/customer', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/customer/get': { logTag: 'BusinessLoan-GetCustomer_INCOMING', api: '/businessloan/customer/get', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/link/get': { logTag: 'BusinessLoan-GetLink_INCOMING', api: '/businessloan/link/get', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/auth/verify': { logTag: 'BusinessLoan-VerifyAuth_INCOMING', api: '/businessloan/auth/verify', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/loanIntent/status': { logTag: 'BusinessLoan-GetLoanIntentStatus_INCOMING', api: '/businessloan/loanIntent/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/loanApplication/status': { logTag: 'BusinessLoan-GetLoanApplicationStatus_INCOMING', api: '/businessloan/loanApplication/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/getKFS': { logTag: 'BusinessLoan-GetKFS_INCOMING', api: '/businessloan/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // TSP HyperCredit APIs
  '/tsp/eligibility': { logTag: 'TSP-Hypercredit-Eligibility_INCOMING', api: '/tsp/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/tsp/order/create': { logTag: 'TSP-Hypercredit-OrderCreate_INCOMING', api: '/tsp/order/create', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/tsp/order/:orderId': { logTag: 'TSP-Hypercredit-OrderStatus_INCOMING', api: '/tsp/order/:orderId', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/tsp/refund': { logTag: 'TSP-HyperCredit-Refund_INCOMING', api: '/tsp/refund', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/tsp/capture': { logTag: 'TSP-HyperCredit-Capture_INCOMING', api: '/tsp/capture', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // Generic Wrapper APIs
  '/api/eligibility': { logTag: 'Generics-Eligibility_INCOMING', api: '/api/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/api/getKFS': { logTag: 'JuspaySDK-GetKFS_INCOMING_generic', api: '/api/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // ==================== APP_CORE (Direct App to Core Endpoints) ====================
  '/api/v3.3/loanStatus': { logTag: 'LSP-LoanStatus_INCOMING', api: '/api/v3.3/loanStatus', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/grantLoan': { logTag: 'LSP-GrantLoanRequest_INCOMING', api: '/api/v3.3/grantLoan', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/getLenderFlows': { logTag: 'LSP-GetFlowLink_INCOMING', api: '/api/v5.0/getLenderFlows', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/customer': { logTag: 'LSP-GetCustomerInfo_INCOMING', api: '/api/v4.0/customer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/updateCustomer': { logTag: 'LSP-UpdateCustomerInfo_INCOMING', api: '/api/v4.0/updateCustomer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/triggerLspOtp': { logTag: 'LSP-TriggerLspOtp_INCOMING', api: '/api/v4.0/triggerLspOtp', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/verifyLspOtp': { logTag: 'LSP-VerifyLspOtp_INCOMING', api: '/api/v4.0/verifyLspOtp', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/priorityLogic': { logTag: 'LSP-PriorityLogic_INCOMING', api: '/api/v5.0/priorityLogic', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/triggerDisbursement': { logTag: 'LSP-TriggerDisbursementAuth_INCOMING', api: '/api/v3.3/triggerDisbursement', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/claStatus': { logTag: 'LSP-CLAStatus_INCOMING', api: '/api/v3.3/claStatus', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/triggerKyc': { logTag: 'LSP-TriggerKYCRequestV5_INCOMING', api: '/api/v5.0/triggerKyc', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/statusKyc': { logTag: 'LSP-StatusKYCFlowRequestV5_INCOMING', api: '/api/v5.0/statusKyc', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/downpayment/trigger': { logTag: 'LSP-TriggerDownPaymentModRequest_INCOMING', api: '/api/v5.0/downpayment/trigger', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/downpayment/status': { logTag: 'LSP-StatusDownPaymentModRequest_INCOMING', api: '/api/v5.0/downpayment/status', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/repayment/trigger': { logTag: 'LSP-TriggerRepaymentModRequest_INCOMING', api: '/api/v5.0/repayment/trigger', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/repayment/status': { logTag: 'LSP-GetRepaymentStatus_INCOMING', api: '/api/v5.0/repayment/status', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/loanAgreement/trigger': { logTag: 'LSP-TriggerLoanAgreement_INCOMING', api: '/api/v5.0/loanAgreement/trigger', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/loanAgreement/status': { logTag: 'LSP-GetLoanAgreementStatus_INCOMING', api: '/api/v5.0/loanAgreement/status', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/setOffer': { logTag: 'LSP-SetOffer_INCOMING', api: '/api/v5.0/setOffer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/generateOffers': { logTag: 'LSP-GenerateOffers_INCOMING', api: '/api/v4.0/generateOffers', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/fetchOfferResponse': { logTag: 'LSP-FetchOfferResponse_INCOMING', api: '/api/v4.0/fetchOfferResponse', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/loanAgreementStatus': { logTag: 'LSP-LoanAgreementStatus_INCOMING', api: '/api/v3.3/loanAgreementStatus', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/getAgreementData': { logTag: 'LSP-GetAgreementDataResponse_INCOMING', api: '/api/v3.3/getAgreementData', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/loanSummary': { logTag: 'LSP-LoanSummary_INCOMING', api: '/api/v3.3/loanSummary', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/loanStatement': { logTag: 'LSP-LoanStatementAccount_INCOMING', api: '/api/v3.3/loanStatement', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v1.0/qr/generate': { logTag: 'LSP-GenerateQR_INCOMING', api: '/api/v1.0/qr/generate', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/createCustomer': { logTag: 'LSP-CreateCustomer_INCOMING', api: '/api/v5.0/createCustomer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/ticket/raise': { logTag: 'LSP-RaiseTicket_INCOMING', api: '/api/v5.0/ticket/raise', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/ticket/list': { logTag: 'LSP-ListTicket_INCOMING', api: '/api/v5.0/ticket/list', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/verifyCustomer': { logTag: 'LSP-VerifyCustomer_INCOMING', api: '/api/v3.3/verifyCustomer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/themis/rules': { logTag: 'LSP-Rules_INCOMING', api: '/api/themis/rules', sourceDestination: 'APP_CORE', headers: {} },
  
  // ==================== CORE_GATEWAY (Core to Gateway/Lender - Outgoing) ====================
  '/gateway/v1.0/eligibility': { logTag: 'LSP-Eligibility_OUTGOING', api: '/gateway/v1.0/eligibility', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/selectOffer': { logTag: 'LSP-SelectOffer_OUTGOING', api: '/gateway/v1.0/selectOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createPayment': { logTag: 'LSP-CreatePayment_OUTGOING', api: '/gateway/v1.0/createPayment', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/order': { logTag: 'LSP-CreateOrder_OUTGOING', api: '/gateway/v1.0/order', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/refund': { logTag: 'LSP-RefundTriggerV2_OUTGOING', api: '/gateway/v1.0/refund', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/refundStatus': { logTag: 'LSP-RefundStatusV2_OUTGOING', api: '/gateway/v1.0/refundStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/grantLoan': { logTag: 'LSP-GrantLoanRequest_OUTGOING', api: '/gateway/v1.0/grantLoan', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/disbursement/trigger': { logTag: 'LSP-TriggerDisbursementAuth_OUTGOING', api: '/gateway/v1.0/disbursement/trigger', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchOffer': { logTag: 'LSP-FetchOfferRequest_OUTGOING', api: '/gateway/v1.0/fetchOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchOfferStatus': { logTag: 'LSP-FetchOfferStatus_OUTGOING', api: '/gateway/v1.0/fetchOfferStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/txnIntent': { logTag: 'LSP-TxnIntent_OUTGOING', api: '/gateway/v1.0/txnIntent', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/txnIntentStatus': { logTag: 'LSP-TxnIntentStatus_OUTGOING', api: '/gateway/v1.0/txnIntentStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/txnIntentUpdate': { logTag: 'LSP-TxnIntentUpdate_OUTGOING', api: '/gateway/v1.0/txnIntentUpdate', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchState': { logTag: 'LSP-FetchState_OUTGOING', api: '/gateway/v1.0/fetchState', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/loanApplicationStatus': { logTag: 'LSP-LoanApplicationStatus_OUTGOING', api: '/gateway/v1.0/loanApplicationStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createLoanApplication': { logTag: 'LSP-CreateLoanApplication_OUTGOING', api: '/gateway/v1.0/createLoanApplication', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createLoanRequestInfo': { logTag: 'LSP-CreateLoanRequestInfo_OUTGOING', api: '/gateway/v1.0/createLoanRequestInfo', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/updateLoanRequestInfo': { logTag: 'LSP-UpdateLoanRequestInfo_OUTGOING', api: '/gateway/v1.0/updateLoanRequestInfo', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createOffer': { logTag: 'LSP-CreateOffer_OUTGOING', api: '/gateway/v1.0/createOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/getKFS': { logTag: 'LSP-GetKFS_OUTGOING', api: '/gateway/v1.0/getKFS', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/hardEligibility': { logTag: 'LSP-HardEligibility_OUTGOING', api: '/gateway/v1.0/hardEligibility', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchOfferSync': { logTag: 'LSP-FetchOfferSync_OUTGOING', api: '/gateway/v1.0/fetchOfferSync', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/triggerActionRequired': { logTag: 'LSP-TriggerActionRequired_OUTGOING', api: '/gateway/v1.0/triggerActionRequired', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/actionRequiredStatus': { logTag: 'LSP-ActionRequiredStatus_OUTGOING', api: '/gateway/v1.0/actionRequiredStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/backRedirection': { logTag: 'LSP-BackRedirection_OUTGOING', api: '/gateway/v1.0/backRedirection', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/customer': { logTag: 'LSP-CreateUpdateCustomer_OUTGOING', api: '/gateway/v1.0/customer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/applicant': { logTag: 'LSP-CreateUpdateApplicant_OUTGOING', api: '/gateway/v1.0/applicant', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/guarantor': { logTag: 'LSP-CreateUpdateGuarantor_OUTGOING', api: '/gateway/v1.0/guarantor', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/getCustomer': { logTag: 'LSP-GetCustomer_OUTGOING', api: '/gateway/v1.0/getCustomer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/getApplicant': { logTag: 'LSP-GetApplicant_OUTGOING', api: '/gateway/v1.0/getApplicant', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/getGuarantor': { logTag: 'LSP-GetGuarantor_OUTGOING', api: '/gateway/v1.0/getGuarantor', sourceDestination: 'CORE_GATEWAY', headers: {} },
  
  // ==================== GATEWAY_CORE (Gateway to Core - Responses/Callbacks) ====================
  '/v1/themis/eligibility/callback': { logTag: 'LSP-Eligibility_INCOMING', api: '/v1/themis/eligibility/callback', sourceDestination: 'GATEWAY_CORE', headers: {} },
  '/v1/themis/grantLoan/callback': { logTag: 'LSP-GrantLoanRequest_INCOMING', api: '/v1/themis/grantLoan/callback', sourceDestination: 'GATEWAY_CORE', headers: {} },
  '/v1/themis/disbursement/callback': { logTag: 'LSP-TriggerDisbursementAuth_INCOMING', api: '/v1/themis/disbursement/callback', sourceDestination: 'GATEWAY_CORE', headers: {} },
  '/v1/themis/gateway/response': { logTag: 'Eligibility Response', api: '/v1/themis/gateway/response', sourceDestination: 'GATEWAY_CORE', headers: {} },
  '/v1/themis/loanStatus/response': { logTag: 'LoanStatus Response', api: '/v1/themis/loanStatus/response', sourceDestination: 'GATEWAY_CORE', headers: {} },
  '/v1/themis/disbursement/response': { logTag: 'Disbursement Response', api: '/v1/themis/disbursement/response', sourceDestination: 'GATEWAY_CORE', headers: {} },
  
  // ==================== CORE_THEMIS (Core to Themis) ====================
  '/themis/v5/sortLenders': { logTag: 'Themis-Eligibility Request', api: '/themis/v5/sortLenders', sourceDestination: 'CORE_THEMIS', headers: {} },
  '/themis/v5/priorityLogic': { logTag: 'Themis-PriorityLogic Request', api: '/themis/v5/priorityLogic', sourceDestination: 'CORE_THEMIS', headers: {} },
  '/themis/v5/breRules': { logTag: 'Themis-GetBreRules Request', api: '/themis/v5/breRules', sourceDestination: 'CORE_THEMIS', headers: {} },
  '/themis/v5/verifyOtp': { logTag: 'Themis-VerifyLspOtp Request', api: '/themis/v5/verifyOtp', sourceDestination: 'CORE_THEMIS', headers: {} },
  '/themis/v5/triggerOtp': { logTag: 'Themis-TriggerLspOtp Request', api: '/themis/v5/triggerOtp', sourceDestination: 'CORE_THEMIS', headers: {} },
  
  // ==================== CORE_APP (Core to App - Responses/Callbacks) ====================
  '/v1/lsp/eligibility/response': { logTag: 'LSP-Eligibility_OUTGOING', api: '/v1/lsp/eligibility/response', sourceDestination: 'CORE_APP', headers: {} },
  '/v1/lsp/loanStatus/response': { logTag: 'LSP-LoanStatus_OUTGOING', api: '/v1/lsp/loanStatus/response', sourceDestination: 'CORE_APP', headers: {} },
  '/webhook/lsp/callback': { logTag: 'LSP-Callback Response', api: '/webhook/lsp/callback', sourceDestination: 'CORE_APP', headers: {} },
  
  // ==================== GATEWAY_LENDER (Gateway to Lender - Lender Side) ====================
  '/lsp/softEligibility': { logTag: 'Themis-Eligibility Request', api: '/lsp/softEligibility', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/lsp/hardEligibility': { logTag: 'Themis-HardEligibility Request', api: '/lsp/hardEligibility', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/lsp/grantLoan': { logTag: 'Themis-GrantLoan Request', api: '/lsp/grantLoan', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/lsp/disbursement': { logTag: 'Themis-Disbursement Request', api: '/lsp/disbursement', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/lsp/fetchOffer': { logTag: 'Themis-FetchOffer Request', api: '/lsp/fetchOffer', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/lsp/selectOffer': { logTag: 'Themis-SelectOffer Request', api: '/lsp/selectOffer', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/lsp/kyc': { logTag: 'Themis-KYC Request', api: '/lsp/kyc', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/lsp/repayment': { logTag: 'Themis-Repayment Request', api: '/lsp/repayment', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  
  // ==================== LENDER_GATEWAY (Lender to Gateway - Callbacks/Webhooks) ====================
  '/gateway/webhook': { logTag: 'WEBHOOK Request', api: '/gateway/webhook', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/gateway/response': { logTag: 'Themis-Eligibility Response', api: '/v1/themis/gateway/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/grantLoan/response': { logTag: 'Themis-GrantLoan Response', api: '/v1/themis/grantLoan/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/disbursement/response': { logTag: 'Themis-Disbursement Response', api: '/v1/themis/disbursement/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/fetchOffer/response': { logTag: 'Themis-FetchOffer Response', api: '/v1/themis/fetchOffer/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/kyc/response': { logTag: 'Themis-KYC Response', api: '/v1/themis/kyc/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/repayment/response': { logTag: 'Themis-Repayment Response', api: '/v1/themis/repayment/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/offers/response': { logTag: 'ThemisGenerateOffersResponse Response', api: '/v1/themis/offers/response', sourceDestination: 'LENDER_GATEWAY', headers: {} }
};

// Destinations that should not be called (external services)
export const SKIP_DESTINATIONS = ['APP', 'LENDER'];

// Async/parallel API calls that can arrive out of order
// Format: { sourceDestination: string, logTagPattern: string | RegExp }
// These APIs are made in parallel by the source service and can arrive in any order
export const ASYNC_PARALLEL_APIS = [
  { sourceDestination: 'GW_LENDER', logTagPattern: /^Themis-Eligibility/ }
];

/**
 * Check if an API call is async/parallel (can arrive out of order)
 * @param {string} sourceDestination - Source to destination (e.g., "GW_LENDER")
 * @param {string} logTag - The log tag for the API
 * @returns {boolean}
 */
export function isAsyncParallelApi(sourceDestination, logTag) {
  return ASYNC_PARALLEL_APIS.some(api => {
    if (api.sourceDestination !== sourceDestination) return false;
    if (typeof api.logTagPattern === 'string') {
      return logTag === api.logTagPattern;
    }
    return api.logTagPattern.test(logTag);
  });
}

// Orchestrator server configuration
export const ORCHESTRATOR_CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3001,
  timeoutMs: parseInt(process.env.TIMEOUT_MS, 10) || 10000,
  autoStart: process.env.AUTO_START !== 'false'
};

// Mock configuration
export const MOCK_CONFIG = {
  enabled: process.env.MOCK_ENABLED === 'true',
  // When mocks are enabled, these URLs override SERVICE_MAP
  mockLspUrl: process.env.MOCK_LSP_URL || 'http://127.0.0.1:4232',
  mockGwUrl: process.env.MOCK_GW_URL || 'http://127.0.0.1:2344'
};

/**
 * Extract the payload from message based on log_tag type
 * - If log_tag ends with "Request" -> use message.trace_request
 * - If log_tag ends with "Response" -> use message.trace_response
 * @param {Object} message - The log message object
 * @param {string} logTag - The log tag
 * @returns {Object|null} - The extracted payload
 */
export function extractPayload(message, logTag) {
  if (!logTag || typeof logTag !== 'string') {
    return null;
  }

  const trimmedTag = logTag.trim();

  if (trimmedTag.endsWith('Request') || trimmedTag.endsWith('_INCOMING')) {
    return message?.trace_request || null;
  }

  if (trimmedTag.endsWith('Response') || trimmedTag.endsWith('_OUTGOING')) {
    return message?.trace_response || null;
  }

  // Default: return null if neither Request nor Response
  return null;
}

/**
 * Get LogTag for an API endpoint
 * @param {string} api - API endpoint path
 * @returns {string|null}
 */
export function getLogTagForApi(api) {
  return API_TO_LOGTAG_MAP[api]?.logTag || null;
}

/**
 * Get full mapping info for an API endpoint
 * @param {string} api - API endpoint path
 * @returns {Object|null} - { logTag, api, sourceDestination }
 */
export function getApiMapping(api) {
  return API_TO_LOGTAG_MAP[api] || null;
}

/**
 * Get API endpoint for a log tag (reverse lookup from API_TO_LOGTAG_MAP)
 * @param {string} logTag - The log tag
 * @returns {string|null} - The API endpoint
 */
export function getApiForLogTag(logTag) {
  const entry = Object.values(API_TO_LOGTAG_MAP).find(m => m.logTag === logTag);
  return entry?.api || null;
}

/**
 * Get endpoint config for a logTag and sourceDestination
 * Tries remapped version first (APP_LSP), falls back to original (APP_WRAPPER)
 * @param {string} sourceDestination
 * @param {string} logTag
 * @returns {Object|null}
 */
export function getEndpointConfig(sourceDestination, logTag) {
  // Try the provided sourceDestination first
  const key = `${sourceDestination}|${logTag}`;
  if (API_TO_ENDPOINT_MAP[key]) {
    return API_TO_ENDPOINT_MAP[key];
  }
  // If not found and it's a remapped version, try the original
  const remappings = {
    'APP_LSP': 'APP_WRAPPER',
    'LSP_APP': 'WRAPPER_APP'
  };
  const original = remappings[sourceDestination];
  if (original) {
    const originalKey = `${original}|${logTag}`;
    return API_TO_ENDPOINT_MAP[originalKey] || null;
  }
  return null;
}
