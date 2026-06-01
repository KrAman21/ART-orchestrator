import './bootstrap-env.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { EnvironmentController } from './services/environment-controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const lendersData = JSON.parse(readFileSync(join(__dirname, 'data', 'lenders.json'), 'utf-8'));

export const LENDER_ORG_ID_TO_ID_MAP = Object.freeze(
  Object.fromEntries(lendersData.map(l => [l.org_id, l.id]))
);

export function getLenderId(orgId) {
  return LENDER_ORG_ID_TO_ID_MAP[orgId] || null;
}

export const envController = new EnvironmentController(process.env.NODE_ENV);
const currentEnv = envController.getConfig();
export const SERVICE_MAP = {
  LSP: { 
    baseUrl: currentEnv.LSP.baseUrl, 
    name: currentEnv.LSP.name,
    unixSocket: currentEnv.LSP.unixSocket 
  },
  GW: { 
    baseUrl: currentEnv.GW.baseUrl, 
    name: currentEnv.GW.name,
    unixSocket: currentEnv.GW.unixSocket 
  },
  GATEWAY: { 
    baseUrl: currentEnv.GATEWAY.baseUrl, 
    name: currentEnv.GATEWAY.name,
    unixSocket: currentEnv.GATEWAY.unixSocket 
  }
};

export const LSP_API_CONFIG = {
  baseUrl: process.env.LSP_API_BASE_URL || 'https://api.juspay.in',
  sessionToken: process.env.SESSION_TOKEN || ''
};

export const QAPI_CONFIG = {
  baseUrl: process.env.QAPI_BASE_URL || 'https://dashboard.credit.juspay.in',
  token: process.env.QAPI_TOKEN || '',
  merchantId: process.env.MERCHANT_ID || 'flipkart'
};

// API endpoint mapping based on (sourceDestination, logTag) combination
// Key format: "sourceDestination|logTag" where sourceDestination is "SOURCE_DEST"
// Optional headers field for custom headers per endpoint
export const API_TO_ENDPOINT_MAP = {
  
  // ── FlipKart (merchantId = "flipkart" | "imposter") ──────────────────────────
  'APP_WRAPPER|FlipKart-RealTimeEligibility_REQUEST':         { endpoint: '/flipkart/txn/eligibility/line',                          method: 'POST', service: 'LSP', headers: {} },

  'APP_WRAPPER|FlipKart-LineOnboarding-Eligibility_REQUEST':       { endpoint: '/flipkart/initiate/line/eligibility',                method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-EligibilityStatus_REQUEST': { endpoint: '/flipkart/initiate/line/eligibility/status',         method: 'POST', service: 'LSP', headers: {} },

  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibility_REQUEST':       { endpoint: '/flipkart/line/eligibility/lender',              method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibilityStatus_REQUEST': { endpoint: '/flipkart/line/eligibility/lender/status',       method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetRedirectionURL_REQUEST':     { endpoint: '/flipkart/line/getRedirectionUrl',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetKFS_REQUEST':                { endpoint: '/flipkart/line/getKFS',                          method: 'POST', service: 'LSP', headers: {} },

  'APP_WRAPPER|FlipKart-LineOnboarding-LineStatus_REQUEST':     { endpoint: '/flipkart/customer/line/status',                       method: 'POST', service: 'LSP', headers: {} },

  // /lineonboarding/* paths share the same handlers as /initiate/line/* and /line/*
  'APP_WRAPPER|FlipKart-LineOnboarding-Eligibility_REQUEST':           { endpoint: '/flipkart/lineonboarding/eligibility',           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-EligibilityStatus_REQUEST':     { endpoint: '/flipkart/lineonboarding/eligibility/status',    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibility_REQUEST':       { endpoint: '/flipkart/lineonboarding/eligibility/lender',    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibilityStatus_REQUEST': { endpoint: '/flipkart/lineonboarding/eligibility/lender/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetRedirectionURL_REQUEST':     { endpoint: '/flipkart/lineonboarding/getRedirectionUrl',     method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetKFS_REQUEST':                { endpoint: '/flipkart/lineonboarding/getKFS',                method: 'POST', service: 'LSP', headers: {} },

  'APP_WRAPPER|FlipKart-Eligibility_REQUEST':         { endpoint: '/flipkart/eligibility',                                          method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-EligibilityStatus_REQUEST':   { endpoint: '/flipkart/eligibility/status',                                   method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-HardEligibility_REQUEST':     { endpoint: '/flipkart/eligibility/lender',                                   method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-HardEligibilityStatus_REQUEST': { endpoint: '/flipkart/eligibility/lender/status',                         method: 'POST', service: 'LSP', headers: {} },

  'APP_WRAPPER|FlipKart-GetKFS_REQUEST':              { endpoint: '/flipkart/getKFS',                                               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-GetRedirectionURL_REQUEST':   { endpoint: '/flipkart/getRedirectionUrl',                                    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-InitaiteTxn_REQUEST':         { endpoint: '/flipkart/txns',                                                 method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-OrderStatus_REQUEST':         { endpoint: '/flipkart/order/status',                                         method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-Refund_REQUEST':              { endpoint: '/flipkart/refund',                                               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-LineOnboarding-FetchLineStatus_REQUEST': { endpoint: '/flipkart/fetch/line/status',                         method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-FetchStatus_REQUEST':         { endpoint: '/flipkart/fetch/status',                                         method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-CreateLoan_REQUEST':          { endpoint: '/flipkart/createLoan',                                           method: 'POST', service: 'LSP', headers: {} },

  // ── FlipKart2W (merchantId = "flipkart2w") ───────────────────────────────────
  'APP_WRAPPER|Flipkart2W-Eligibility_REQUEST':           { endpoint: '/flipkart2w/eligibility',                                    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|Flipkart2W-EligibilityStatus_REQUEST':     { endpoint: '/flipkart2w/eligibility/status',                             method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-2W-HardEligibility_REQUEST':      { endpoint: '/flipkart2w/eligibility/lender',                             method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart2W-HardEligibilityStatus_REQUEST': { endpoint: '/flipkart2w/eligibility/lender/status',                      method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-GetKFS_REQUEST':                  { endpoint: '/flipkart2w/getKFS',                                         method: 'POST', service: 'LSP', headers: {} }, // same logTag as FK1
  'APP_WRAPPER|FlipKart-2W_REQUEST':                      { endpoint: '/flipkart2w/getRedirectionUrl',                              method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart2W-InitaiteTxn_REQUEST':           { endpoint: '/flipkart2w/txns',                                           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart2W-Refund_REQUEST':                { endpoint: '/flipkart2w/refund',                                         method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart2W-FetchStatus_REQUEST':           { endpoint: '/flipkart2w/fetch/status',                                   method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart2W-CreateLoan_REQUEST':            { endpoint: '/flipkart2w/createLoan',                                     method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart2W-CreatePayment_REQUEST':         { endpoint: '/flipkart2w/dp/create',                                      method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart2W-CustomerStatus_REQUEST':        { endpoint: '/flipkart2w/customer/status',                                method: 'POST', service: 'LSP', headers: {} },

  // ── FlipKartSuperMoney (merchantId = "flipkartSM") ───────────────────────────
  'APP_WRAPPER|FlipKartSuperMoney-GetRedirectionURL_REQUEST': { endpoint: '/flipkartSM/getRedirectionUrl',                          method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKartSuperMoney-InitiateTxn_REQUEST':       { endpoint: '/flipkartSM/txns',                                       method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|FlipKart-OrderStatus_REQUEST':                 { endpoint: '/flipkartSM/order/status',                               method: 'POST', service: 'LSP', headers: {} }, // same logTag as FK1
  'APP_WRAPPER|FlipKart-Refund_REQUEST':                      { endpoint: '/flipkartSM/refund',                                     method: 'POST', service: 'LSP', headers: {} }, // same logTag as FK1
  'APP_WRAPPER|FlipKart-FetchStatus_REQUEST':                 { endpoint: '/flipkartSM/fetch/status',                               method: 'POST', service: 'LSP', headers: {} }, // same logTag as FK1

  // ── JuspaySDK (prefix: /sdk/) ────────────────────────────────────────────────
  'APP_WRAPPER|JuspaySDK-SoftEligiblity_REQUEST':                   { endpoint: '/sdk/eligibility',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-VerifyLspOtp_REQUEST':                     { endpoint: '/sdk/verifyLspOtp',              method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-CreateLoanApplication_REQUEST':            { endpoint: '/sdk/createLoanApplication',     method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOffer-HardEligibility_REQUEST':       { endpoint: '/sdk/fetchOffer',                method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOfferStatus-HardEligibility-SDK_REQUEST': { endpoint: '/sdk/fetchOfferStatus',      method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-SetOffer_REQUEST':                         { endpoint: '/sdk/offer/set',                 method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetJourneyUrl_REQUEST':                    { endpoint: '/sdk/journey/url/get',           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|GetFlowLink-SDK_REQUEST':                            { endpoint: '/sdk/getFlowLink',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-ResumeJourney_REQUEST':                    { endpoint: '/sdk/journey/resume',            method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-TriggerOTP_REQUEST':                       { endpoint: '/sdk/otp/trigger',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GenerateOffers_REQUEST':                   { endpoint: '/sdk/offers/generate',           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetOffers_REQUEST':                        { endpoint: '/sdk/offers/get',                method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TriggerActionRequired_REQUEST':                      { endpoint: '/sdk/actionRequired/trigger',    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TriggerActionRequired_REQUEST':                      { endpoint: '/sdk/actionRequired/status',     method: 'POST', service: 'LSP', headers: {} }, // same logTag

  // ── BusinessLoan (prefix: /businessloan/) ────────────────────────────────────
  'APP_WRAPPER|BL-CreateUpdateCustomer_REQUEST':                     { endpoint: '/businessloan/customer',                   method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BL-GetCustomer_REQUEST':                              { endpoint: '/businessloan/customer/get',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetLink_REQUEST':                        { endpoint: '/businessloan/link/get',                   method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BL-VerifyAuth_REQUEST':                               { endpoint: '/businessloan/auth/verify',                method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-SoftEligibility_REQUEST':                { endpoint: '/businessloan/eligibility/soft',           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-HardEligibility-FetchOfferRequest_REQUEST': { endpoint: '/businessloan/eligibility/hard',        method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-HardEligibility-FetchOfferStatus_REQUEST':  { endpoint: '/businessloan/eligibility/hard/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-LoanIntentStatus_REQUEST':               { endpoint: '/businessloan/loanIntent/status',          method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-LoanApplicationStatus_REQUEST':          { endpoint: '/businessloan/loanApplication/status',     method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetKFS_REQUEST':                         { endpoint: '/businessloan/getKFS',                     method: 'POST', service: 'LSP', headers: {} },

  // ── TSPHyperCredit (prefix: /tsp/) ───────────────────────────────────────────
  'APP_WRAPPER|TSP-Hypercredit-OrderCreate_REQUEST':  { endpoint: '/tsp/order/create',    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-Hypercredit-OrderStatus_REQUEST':  { endpoint: '/tsp/order/{orderId}', method: 'GET',  service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-HyperCredit-Refund_REQUEST':       { endpoint: '/tsp/refund',          method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-HyperCredit-Capture_REQUEST':      { endpoint: '/tsp/capture',         method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-Hypercredit-Eligibility_REQUEST':  { endpoint: '/tsp/eligibility',     method: 'POST', service: 'LSP', headers: {} },

  // ── Euler (prefix: /api/lsp/) ────────────────────────────────────────────────
  'APP_WRAPPER|Euler-ETB-Eligibility_REQUEST':  { endpoint: '/api/lsp/eligibility',  method: 'POST', service: 'LSP', headers: {} },

  // ── Generic / JuspaySDK (prefix: /api/) ─────────────────────────────────────
  // ── JuspaySDK (prefix: /sdk/) ────────────────────────────────────────────────
  'APP_WRAPPER|JuspaySDK-SoftEligiblity_REQUEST':                   { endpoint: '/sdk/eligibility',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-VerifyLspOtp_REQUEST':                     { endpoint: '/sdk/verifyLspOtp',              method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-CreateLoanApplication_REQUEST':            { endpoint: '/sdk/createLoanApplication',     method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOffer-HardEligibility_REQUEST':       { endpoint: '/sdk/fetchOffer',                method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-FetchOfferStatus-HardEligibility-SDK_REQUEST': { endpoint: '/sdk/fetchOfferStatus',      method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-SetOffer_REQUEST':                         { endpoint: '/sdk/offer/set',                 method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetJourneyUrl_REQUEST':                    { endpoint: '/sdk/journey/url/get',           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|GetFlowLink-SDK_REQUEST':                            { endpoint: '/sdk/getFlowLink',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-ResumeJourney_REQUEST':                    { endpoint: '/sdk/journey/resume',            method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-TriggerOTP_REQUEST':                       { endpoint: '/sdk/otp/trigger',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GenerateOffers_REQUEST':                   { endpoint: '/sdk/offers/generate',           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-GetOffers_REQUEST':                        { endpoint: '/sdk/offers/get',                method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TriggerActionRequired_REQUEST':                      { endpoint: '/sdk/actionRequired/trigger',    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TriggerActionRequired_REQUEST':                      { endpoint: '/sdk/actionRequired/status',     method: 'POST', service: 'LSP', headers: {} }, // same logTag

  // ── BusinessLoan (prefix: /businessloan/) ────────────────────────────────────
  'APP_WRAPPER|BL-CreateUpdateCustomer_REQUEST':                     { endpoint: '/businessloan/customer',                   method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BL-GetCustomer_REQUEST':                              { endpoint: '/businessloan/customer/get',               method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetLink_REQUEST':                        { endpoint: '/businessloan/link/get',                   method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BL-VerifyAuth_REQUEST':                               { endpoint: '/businessloan/auth/verify',                method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-SoftEligibility_REQUEST':                { endpoint: '/businessloan/eligibility/soft',           method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-HardEligibility-FetchOfferRequest_REQUEST': { endpoint: '/businessloan/eligibility/hard',        method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-HardEligibility-FetchOfferStatus_REQUEST':  { endpoint: '/businessloan/eligibility/hard/status', method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-LoanIntentStatus_REQUEST':               { endpoint: '/businessloan/loanIntent/status',          method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-LoanApplicationStatus_REQUEST':          { endpoint: '/businessloan/loanApplication/status',     method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|BusinessLoan-GetKFS_REQUEST':                         { endpoint: '/businessloan/getKFS',                     method: 'POST', service: 'LSP', headers: {} },

  // ── TSPHyperCredit (prefix: /tsp/) ───────────────────────────────────────────
  'APP_WRAPPER|TSP-Hypercredit-OrderCreate_REQUEST':  { endpoint: '/tsp/order/create',    method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-Hypercredit-OrderStatus_REQUEST':  { endpoint: '/tsp/order/{orderId}', method: 'GET',  service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-HyperCredit-Refund_REQUEST':       { endpoint: '/tsp/refund',          method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-HyperCredit-Capture_REQUEST':      { endpoint: '/tsp/capture',         method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|TSP-Hypercredit-Eligibility_REQUEST':  { endpoint: '/tsp/eligibility',     method: 'POST', service: 'LSP', headers: {} },

  // ── Euler (prefix: /api/lsp/) ────────────────────────────────────────────────
  'APP_WRAPPER|Euler-ETB-Eligibility_REQUEST':  { endpoint: '/api/lsp/eligibility',  method: 'POST', service: 'LSP', headers: {} },

  // ── Generic / JuspaySDK (prefix: /api/) ─────────────────────────────────────
  'APP_WRAPPER|JUSPAY_SDK_REQUEST':        { endpoint: '/api/eligibility', method: 'POST', service: 'LSP', headers: {} }, // commonAuth-based, used by galaxyHealth too
  'APP_WRAPPER|JuspaySDK-GetKFS_REQUEST':  { endpoint: '/api/getKFS',      method: 'POST', service: 'LSP', headers: {} },

  // ── PayIn3 (prefix: /payin3/) — note: type has duplicate "payin3" prefix ─────
  'APP_WRAPPER|PayIn3-SoftEligiblity_REQUEST':  { endpoint: '/payin3/payin3/eligibility',  method: 'POST', service: 'LSP', headers: {} },
  'APP_WRAPPER|JuspaySDK-SetOfferV2_REQUEST':   { endpoint: '/payin3/payin3/offer/set',     method: 'POST', service: 'LSP', headers: {} },



  // ==================== APP_WRAPPER (Wrapper Endpoints - Incoming from APP) ====================
  // FlipKart APIs
  'APP_WRAPPER|FlipKart-Eligibility_INCOMING': { endpoint: '/flipkart/eligibility', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-EligibilityStatus_REQUEST': { endpoint: '/flipkart/eligibility/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-HardEligibility_REQUEST': { endpoint: '/flipkart/eligibility/lender', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-HardEligibilityStatus_REQUEST': { endpoint: '/flipkart/eligibility/lender/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-GetKFS_REQUEST': { endpoint: '/flipkart/getKFS', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-GetRedirectionURL_REQUEST': { endpoint: '/flipkart/getRedirectionUrl', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-InitaiteTxn_REQUEST': { endpoint: '/flipkart/txns', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-OrderStatus_REQUEST': { endpoint: '/flipkart/order/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-Refund_INCOMING': { endpoint: '/flipkart/refund', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-FetchStatus_INCOMING': { endpoint: '/flipkart/fetch/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-CreateLoan_INCOMING': { endpoint: '/flipkart/createLoan', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-Eligibility_REQUEST': { endpoint: '/flipkart/eligibility', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  
  // FlipKart Line Onboarding APIs
  'APP_WRAPPER|FlipKart-LineOnboarding-Eligibility_INCOMING': { endpoint: '/flipkart/initiate/line/eligibility', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-EligibilityStatus_INCOMING': { endpoint: '/flipkart/initiate/line/eligibility/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibility_INCOMING': { endpoint: '/flipkart/line/eligibility/lender', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-HardEligibilityStatus_INCOMING': { endpoint: '/flipkart/line/eligibility/lender/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetRedirectionURL_INCOMING': { endpoint: '/flipkart/line/getRedirectionUrl', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-GetKFS_INCOMING': { endpoint: '/flipkart/line/getKFS', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-LineStatus_INCOMING': { endpoint: '/flipkart/customer/line/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-LineOnboarding-FetchLineStatus_INCOMING': { endpoint: '/flipkart/fetch/line/status', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  'APP_WRAPPER|FlipKart-RealTimeEligibility_REQUEST': { endpoint: '/flipkart/txn/eligibility/line', method: 'POST', service: 'LSP', headers: {'disable_encryption': 'TRUE', 'authorization': 'Basic flipkart'} },
  
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
  'APP_CORE|LSP-LoanStatus_REQUEST':{endpoint:'credit/api/v3.3/loan/status', method:'POST', service:'LSP', headers:{}},
  'APP_CORE|GetLenderFlows_REQUEST': {endpoint:'credit/api/v4.0/getLenderFlows', method:'POST', service:'LSP', headers:{}},
  'APP_CORE|LSP-VerifyLspOtp_REQUEST': { endpoint: 'credit/api/v4.0/lspotp/verify', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GrantLoanRequest_REQUEST': { endpoint: 'credit/api/v3.3/grantLoan', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetFlowLink_REQUEST': { endpoint: 'credit/api/v5.0/getLenderFlows', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetCustomerInfo_REQUEST': { endpoint: 'credit/api/v4.0/customer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-UpdateCustomerInfo_REQUEST': { endpoint: 'credit/api/v4.0/updateCustomer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerLspOtp_REQUEST': { endpoint: 'credit/api/v4.0/triggerLspOtp', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-VerifyLspOtp_INCOMING': { endpoint: 'credit/api/v4.0/verifyLspOtp', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-LoanStatus_INCOMING': { endpoint: 'credit/api/v3.3/loanStatus', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GrantLoanRequest_INCOMING': { endpoint: 'credit/api/v3.3/grantLoan', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetFlowLink_INCOMING': { endpoint: 'credit/api/v5.0/getLenderFlows', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-GetCustomerInfo_INCOMING': { endpoint: 'credit/api/v4.0/customer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-UpdateCustomerInfo_INCOMING': { endpoint: 'credit/api/v4.0/updateCustomer', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerLspOtp_INCOMING': { endpoint: 'credit/api/v4.0/triggerLspOtp', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-PriorityLogic_INCOMING': { endpoint: 'credit/api/v5.0/priorityLogic', method: 'POST', service: 'LSP', headers: {} },
  'APP_CORE|LSP-TriggerDisbursementAuth_INCOMING': { endpoint: 'credit/api/v3.3/triggerDisbursement', method: 'POST', service: 'LSP', headers: {} },
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
  
  // ==================== CORE_GATEWAY (Core to Gateway/Lender - Outgoing/REQUEST) ====================
  // REQUEST variants (used by logs.json)
  'CORE_GATEWAY|LSP-GetKFS_REQUEST': { endpoint: '/gateway/v1.0/getKFS', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|FetchOfferRequest_REQUEST': { endpoint: '/gateway/v1.0/fetchOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-Eligibility_REQUEST': { endpoint: '/gateway/v1.0/eligibility', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-SelectOffer_REQUEST': { endpoint: '/gateway/v3.3/offer/setOfferRequest', method: 'POST', service: 'GW', headers: {} }, // duplicate logTag for backward compatibility
  'CORE_GATEWAY|LSP-CreatePayment_REQUEST': { endpoint: '/gateway/v1.0/createPayment', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateOrder_REQUEST': { endpoint: '/gateway/v1.0/order', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-RefundTriggerV2_REQUEST': { endpoint: '/gateway/v1.0/refund', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-RefundStatusV2_REQUEST': { endpoint: '/gateway/v1.0/refundStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-GrantLoanRequest_REQUEST': { endpoint: '/gateway/v1.0/grantLoan', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TriggerDisbursementAuth_REQUEST': { endpoint: '/gateway/v1.0/disbursement/trigger', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchOfferRequest_REQUEST': { endpoint: '/gateway/v1.0/fetchOfferRequest', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchOfferStatus_REQUEST': { endpoint: '/gateway/v1.0/fetchOfferStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TxnIntent_REQUEST': { endpoint: '/gateway/v1.0/txnIntent', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TxnIntentStatus_REQUEST': { endpoint: '/gateway/v1.0/txnIntentStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TxnIntentUpdate_REQUEST': { endpoint: '/gateway/v1.0/txnIntentUpdate', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchState_REQUEST': { endpoint: '/gateway/v1.0/fetchState', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-LoanApplicationStatus_REQUEST': { endpoint: '/gateway/v1.0/loanApplicationStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateLoanApplication_REQUEST': { endpoint: '/gateway/v1.0/createLoanApplication', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateLoanRequestInfo_REQUEST': { endpoint: '/gateway/v1.0/createLoanRequestInfo', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-UpdateLoanRequestInfo_REQUEST': { endpoint: '/gateway/v1.0/updateLoanRequestInfo', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateOffer_REQUEST': { endpoint: '/gateway/v1.0/createOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-GetKFS_REQUEST': { endpoint: '/gateway/v1.0/getKFS', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-HardEligibility_REQUEST': { endpoint: '/gateway/v1.0/hardEligibility', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-FetchOfferSync_REQUEST': { endpoint: '/gateway/v1.0/fetchOfferSync', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-TriggerActionRequired_REQUEST': { endpoint: '/gateway/v1.0/triggerActionRequired', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-ActionRequiredStatus_REQUEST': { endpoint: '/gateway/v1.0/actionRequiredStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-BackRedirection_REQUEST': { endpoint: '/gateway/v1.0/backRedirection', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateUpdateCustomer_REQUEST': { endpoint: '/gateway/v1.0/customer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-CreateUpdateApplicant_REQUEST': { endpoint: '/gateway/v1.0/applicant', method: 'POST', service: 'GW', headers: {} },

  // Original OUTGOING mappings (kept for compatibility)
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
  // REQUEST/RESPONSE mappings (actual log format from production)
  'CORE_GATEWAY|Lsp-LoanStatusRequest_REQUEST':{endpoint: '/gateway/v4.0/loanStatusRequest', method: 'POST', service: 'GW', headers: {}},
  'CORE_GATEWAY|LSP-Eligibility_REQUEST': { endpoint: '/gateway/v1.0/eligibility', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|LSP-Eligibility_RESPONSE': { endpoint: '/gateway/v1.0/eligibility', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|GetRefundDetails-LSP_REQUEST': { endpoint: '/gateway/v1.0/getRefundDetails', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|GetRefundDetails-LSP_RESPONSE': { endpoint: '/gateway/v1.0/getRefundDetails', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|RefundStatusGatewayPT_REQUEST': { endpoint: '/gateway/v1.0/refundStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|RefundStatusGatewayPT_RESPONSE': { endpoint: '/gateway/v1.0/refundStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|Lsp-LoanStatusRequest_RESPONSE': { endpoint: '/gateway/v1.0/loanStatus', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|SetOffer-LSP_REQUEST': { endpoint: '/gateway/v1.0/selectOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|SetOffer-LSP_RESPONSE': { endpoint: '/gateway/v1.0/selectOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|GenerateOfferRequest-LSP_REQUEST': { endpoint: '/gateway/v1.0/createOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|GenerateOfferRequest-LSP_RESPONSE': { endpoint: '/gateway/v1.0/createOffer', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|CreateLoanApplication_V4_1-LSP_REQUEST': { endpoint: '/gateway/v1.0/createLoanApplication', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|CreateLoanApplication_V4_1-LSP_RESPONSE': { endpoint: '/gateway/v1.0/createLoanApplication', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|TriggerRefund-LSP_REQUEST': { endpoint: '/gateway/v1.0/refund', method: 'POST', service: 'GW', headers: {} },
  'CORE_GATEWAY|TriggerRefund-LSP_RESPONSE': { endpoint: '/gateway/v1.0/refund', method: 'POST', service: 'GW', headers: {} },
  
  // ==================== GATEWAY_CORE (Gateway to Core - Responses/Callbacks) ====================
  'GATEWAY_CORE|LSP-Eligibility_INCOMING': { endpoint: '/v1/themis/eligibility/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|LSP-Eligibility_RESPONSE': { endpoint: '/v1/themis/eligibility/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|LSP-GrantLoanRequest_INCOMING': { endpoint: '/v1/themis/grantLoan/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|LSP-TriggerDisbursementAuth_INCOMING': { endpoint: '/v1/themis/disbursement/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|Eligibility Response': { endpoint: '/v1/themis/gateway/response', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|LoanStatus Response': { endpoint: '/v1/themis/loanStatus/response', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|Disbursement Response': { endpoint: '/v1/themis/disbursement/response', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|GATEWAY_WEBHOOK_V4_1_RESPONSE': { endpoint: '/v1/themis/gateway/webhook', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|ASYNC_RESPONSE_LSP-FetchOfferResponse_REQUEST': { endpoint: '/v1/themis/async/fetchOffer', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_CORE|CreateLoanApplicationResponse-V4_1_RESPONSE': { endpoint: '/v1/themis/createLoanApplication/response', method: 'POST', service: 'LSP', headers: {} },
  
  // ==================== CORE_THEMIS (Core to Themis) ====================
  'CORE_THEMIS|Themis-Eligibility Request': { endpoint: '/themis/v5/sortLenders', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-PriorityLogic Request': { endpoint: '/themis/v5/priorityLogic', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-GetBreRules Request': { endpoint: '/themis/v5/breRules', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-VerifyLspOtp Request': { endpoint: '/themis/v5/verifyOtp', method: 'POST', service: 'THEMIS', headers: {} },
  'CORE_THEMIS|Themis-TriggerLspOtp Request': { endpoint: '/themis/v5/triggerOtp', method: 'POST', service: 'THEMIS', headers: {} },
  
  // ==================== CORE_APP (Core to App - Responses/Callbacks) ====================
  'CORE_APP|FetchState_RESPONSE': { endpoint: '/v1/lsp/fetchState/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-GetCustomerInfo_RESPONSE': { endpoint: '/v1/lsp/getCustomerInfo/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-UpdateCustomerInfo_RESPONSE': { endpoint: '/v1/lsp/updateCustomerInfo/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|InitiateBureau_RESPONSE': { endpoint: '/v1/lsp/initiateBureau/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|CreateLoanApplication_V4_1_RESPONSE': { endpoint: '/v1/lsp/createLoanApplication/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-CLAStatus_RESPONSE': { endpoint: '/v1/lsp/claStatus/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|GenerateOfferRequest_RESPONSE': { endpoint: '/v1/lsp/generateOffer/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|FetchOfferStatus_RESPONSE': { endpoint: '/v1/lsp/fetchOfferStatus/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|SetOffer_RESPONSE': { endpoint: '/v1/lsp/setOffer/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|Lsp-GrantLoanRequest_RESPONSE': { endpoint: '/v1/lsp/grantLoan/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-LoanStatus_RESPONSE': { endpoint: '/v1/lsp/loanStatus/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-Eligibility_OUTGOING': { endpoint: '/v1/lsp/eligibility/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-LoanStatus_OUTGOING': { endpoint: '/v1/lsp/loanStatus/response', method: 'POST', service: 'APP', headers: {} },
  'CORE_APP|LSP-Callback Response': { endpoint: '/webhook/lsp/callback', method: 'POST', service: 'APP', headers: {} },
  
  // ==================== GATEWAY_LENDER/GATEWAY_LSP (Gateway to Lender/LSP - Lender Side) ====================
  // Support both formats: "Themis-Eligibility Request" (incoming) and "Themis-Eligibility_REQUEST" (logs)
  // ============================================================================
  // THEMIS LENDER APIs
  // ============================================================================
  
  // Themis Eligibility APIs
  'GATEWAY_LENDER|POLLING API :: LINE_STATUS_REQUEST': {endpoint: '/pb-uat-polling', method: 'POST', service: 'LENDER', headers: {}}, 
  'GATEWAY_LENDER|HDB_TOKEN_API_REQUEST': { endpoint: '/api/v1/authenticate-token', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|Themis-Eligibility Request': { endpoint: '/lsp/softEligibility', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-Eligibility_REQUEST': { endpoint: '/lsp/softEligibility', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-Eligibility Response': { type: 'EligibilityResponse', headers: {} },
  'GATEWAY_LENDER|Themis-Eligibility_RESPONSE': { type: 'EligibilityResponse', headers: {} },
  
  'GATEWAY_LENDER|Themis-HardEligibility Request': { endpoint: '/lsp/eligibility/offers', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibility_REQUEST': { endpoint: '/lsp/eligibility/offers', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibility Response': { type: 'EligibilityResponse', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibility_RESPONSE': { type: 'EligibilityResponse', headers: {} },
  
  'GATEWAY_LENDER|Themis-HardEligibilityEncrypt Request': { endpoint: '/lsp/eligibility/offers', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibilityEncrypt_REQUEST': { endpoint: '/lsp/eligibility/offers', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibilityEncrypt Response': { type: 'EligibilityResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|Themis-HardEligibilityEncrypt_RESPONSE': { type: 'EligibilityResponse', headers: {}, encrypted: true },
  
  // Themis KFS APIs
  'GATEWAY_LENDER|Themis-PLKFS Request': { endpoint: '/lsp/generateKFS', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-PLKFS_REQUEST': { endpoint: '/lsp/generateKFS', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-PLKFS Response': { type: 'ThemisPLKfsResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|Themis-PLKFS_RESPONSE': { type: 'ThemisPLKfsResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|Themis-KFS Request': { endpoint: '/lsp/generateKFS', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-KFS_REQUEST': { endpoint: '/lsp/generateKFS', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-KFS Response': { type: 'ThemisKfsResponse', headers: {} },
  'GATEWAY_LENDER|Themis-KFS_RESPONSE': { type: 'ThemisKfsResponse', headers: {} },
  
  // Themis Generate Offers APIs
  'GATEWAY_LENDER|Themis-GenerateOffers Request': { endpoint: '/offer/themisGenerateOffersRequest', method: 'POST', service: 'OFFER', headers: {} },
  'GATEWAY_LENDER|Themis-GenerateOffers_REQUEST': { endpoint: '/offer/themisGenerateOffersRequest', method: 'POST', service: 'OFFER', headers: {} },
  'GATEWAY_LENDER|Themis-GenerateOffers Response': { type: 'ThemisGenerateOffersResponse', headers: {} },
  'GATEWAY_LENDER|Themis-GenerateOffers_RESPONSE': { type: 'ThemisGenerateOffersResponse', headers: {} },
  
  'GATEWAY_LENDER|Themis-GenerateOffersEncrypt Request': { endpoint: '/offer/themisGenerateOffersRequest', method: 'POST', service: 'OFFER', headers: {} },
  'GATEWAY_LENDER|Themis-GenerateOffersEncrypt_REQUEST': { endpoint: '/offer/themisGenerateOffersRequest', method: 'POST', service: 'OFFER', headers: {} },
  'GATEWAY_LENDER|Themis-GenerateOffersEncrypt Response': { type: 'ThemisGenerateOffersResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|Themis-GenerateOffersEncrypt_RESPONSE': { type: 'ThemisGenerateOffersResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|Themis-ETBGenerateOffers Request': { endpoint: '/offer/themisGenerateOffersRequest', method: 'POST', service: 'OFFER', headers: {} },
  'GATEWAY_LENDER|Themis-ETBGenerateOffers_REQUEST': { endpoint: '/offer/themisGenerateOffersRequest', method: 'POST', service: 'OFFER', headers: {} },
  'GATEWAY_LENDER|Themis-ETBGenerateOffers Response': { type: 'ThemisGenerateOffersResponse', headers: {} },
  'GATEWAY_LENDER|Themis-ETBGenerateOffers_RESPONSE': { type: 'ThemisGenerateOffersResponse', headers: {} },
  
  // Themis EMI Plans APIs
  'GATEWAY_LENDER|Themis-EMIPlans Request': { endpoint: '/etb/v1/emiplans', method: 'POST', service: 'ETB', headers: {} },
  'GATEWAY_LENDER|Themis-EMIPlans_REQUEST': { endpoint: '/etb/v1/emiplans', method: 'POST', service: 'ETB', headers: {} },
  'GATEWAY_LENDER|Themis-EMIPlans Response': { type: 'ThemisEMIPlansResponse', headers: {} },
  'GATEWAY_LENDER|Themis-EMIPlans_RESPONSE': { type: 'ThemisEMIPlansResponse', headers: {} },
  
  'GATEWAY_LENDER|Themis-EMIPlansEncrypt Request': { endpoint: '/etb/v1/emiplans', method: 'POST', service: 'ETB', headers: {} },
  'GATEWAY_LENDER|Themis-EMIPlansEncrypt_REQUEST': { endpoint: '/etb/v1/emiplans', method: 'POST', service: 'ETB', headers: {} },
  'GATEWAY_LENDER|Themis-EMIPlansEncrypt Response': { type: 'ThemisEMIPlansResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|Themis-EMIPlansEncrypt_RESPONSE': { type: 'ThemisEMIPlansResponse', headers: {}, encrypted: true },

  // ============================================================================
  // LIQUILOANS LENDER APIs
  // ============================================================================
  'GATEWAY_LENDER|CHECK ELIGIBILITY API_REQUEST': { endpoint: '/base/flipkart/fk/checkEligibility', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_TOKEN_API_REQUEST': { endpoint: '/api/hdb/token', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetSchemeList Request': { endpoint: '/api/dealer/schemes', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetSchemeList_REQUEST': { endpoint: '/api/dealer/schemes', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetSchemeList Response': { type: 'GetSchemeListResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetSchemeList_RESPONSE': { type: 'GetSchemeListResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-LeadSeamless Request': { endpoint: '/api/apiintegration/v2/CreateLead', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-LeadSeamless_REQUEST': { endpoint: '/api/apiintegration/v2/CreateLead', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-LeadSeamless Response': { type: 'LeadSeamlessResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-LeadSeamless_RESPONSE': { type: 'LeadSeamlessResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-CheckLoanStatus Request': { endpoint: '/api/apiintegration/v2/CheckStatus', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-CheckLoanStatus_REQUEST': { endpoint: '/api/apiintegration/v2/CheckStatus', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-CheckLoanStatus Response': { type: 'CheckLoanStatusResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-CheckLoanStatus_RESPONSE': { type: 'CheckLoanStatusResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-GetCalculatedEmi Request': { endpoint: '/api/apiintegration/los/dealer/get-emi-calculated', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetCalculatedEmi_REQUEST': { endpoint: '/api/apiintegration/los/dealer/get-emi-calculated', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetCalculatedEmi Response': { type: 'GetCalculatedEmiResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetCalculatedEmi_RESPONSE': { type: 'GetCalculatedEmiResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-MandateProcess Request': { endpoint: '/api/apiintegration/v2/getMandateLink', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-MandateProcess_REQUEST': { endpoint: '/api/apiintegration/v2/getMandateLink', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-MandateProcess Response': { type: 'MandateProcessAPIResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-MandateProcess_RESPONSE': { type: 'MandateProcessAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-MandateStatus Request': { endpoint: '/api/credit-line/v1/mandate-log-status', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-MandateStatus_REQUEST': { endpoint: '/api/credit-line/v1/mandate-log-status', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-MandateStatus Response': { type: 'CheckMandateStatusResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-MandateStatus_RESPONSE': { type: 'CheckMandateStatusResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-AddBankingDetails Request': { endpoint: '/api/apiintegration/v2/Add/BankingDetails', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AddBankingDetails_REQUEST': { endpoint: '/api/apiintegration/v2/Add/BankingDetails', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AddBankingDetails Response': { type: 'AddBankingDetailsResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AddBankingDetails_RESPONSE': { type: 'AddBankingDetailsResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-GetAgreementPdf Request': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/getAgreementPdf', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetAgreementPdf_REQUEST': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/getAgreementPdf', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetAgreementPdf Response': { type: 'GetAgreementPDFResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetAgreementPdf_RESPONSE': { type: 'GetAgreementPDFResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-SendAgreementOTP Request': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/sendAgreementOTP', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-SendAgreementOTP_REQUEST': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/sendAgreementOTP', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-SendAgreementOTP Response': { type: 'SendAgreementOTPResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-SendAgreementOTP_RESPONSE': { type: 'SendAgreementOTPResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-VerifyAgreementOTP Request': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/verifyAgreementOTP', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-VerifyAgreementOTP_REQUEST': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/verifyAgreementOTP', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-VerifyAgreementOTP Response': { type: 'VerifyAgreementOTPResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-VerifyAgreementOTP_RESPONSE': { type: 'VerifyAgreementOTPResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-GetAgreementStatus Request': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/getAgreementStatus', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetAgreementStatus_REQUEST': { endpoint: '/api/apiintegration/v2/Generic/NonCaptive/getAgreementStatus', method: 'GET', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetAgreementStatus Response': { type: 'GetAgreementStatusResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-GetAgreementStatus_RESPONSE': { type: 'GetAgreementStatusResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmi Request': { endpoint: '/api/apiintegration/get-dp-link', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmi_REQUEST': { endpoint: '/api/apiintegration/get-dp-link', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmi Response': { type: 'AdvancedEmiAPIResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmi_RESPONSE': { type: 'AdvancedEmiAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmiStatus Request': { endpoint: '/api/apiintegration/get-dp-status', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmiStatus_REQUEST': { endpoint: '/api/apiintegration/get-dp-status', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmiStatus Response': { type: 'AdvancedEmiStatusAPIResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-AdvancedEmiStatus_RESPONSE': { type: 'AdvancedEmiStatusAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-VerifyAndDownloadCkyc Request': { endpoint: '/api/apiintegration/v3/Dealer/VerifyAndDownloadCkycV3', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-VerifyAndDownloadCkyc_REQUEST': { endpoint: '/api/apiintegration/v3/Dealer/VerifyAndDownloadCkycV3', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-VerifyAndDownloadCkyc Response': { type: 'VerifyAndDownloadCkycResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-VerifyAndDownloadCkyc_RESPONSE': { type: 'VerifyAndDownloadCkycResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-UpdateAddress Request': { endpoint: '/api/apiintegration/v2/updateAddress', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UpdateAddress_REQUEST': { endpoint: '/api/apiintegration/v2/updateAddress', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UpdateAddress Response': { type: 'UpdateAddressAPIResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UpdateAddress_RESPONSE': { type: 'UpdateAddressAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-UpdateAadhaarOKycDetails Request': { endpoint: '/api/apiintegration/v2/Borrower/UpdateAadhaarOKycDetails', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UpdateAadhaarOKycDetails_REQUEST': { endpoint: '/api/apiintegration/v2/Borrower/UpdateAadhaarOKycDetails', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UpdateAadhaarOKycDetails Response': { type: 'UpdateAadhaarOKycDetailsResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UpdateAadhaarOKycDetails_RESPONSE': { type: 'UpdateAadhaarOKycDetailsResponse', headers: {} },
  
  'GATEWAY_LENDER|LiquiLoans-UploadDocument Request': { endpoint: '/api/apiintegration/v2/UploadDocument', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UploadDocument_REQUEST': { endpoint: '/api/apiintegration/v2/UploadDocument', method: 'POST', service: 'LIQUILOANS', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UploadDocument Response': { type: 'UploadDocumentResponse', headers: {} },
  'GATEWAY_LENDER|LiquiLoans-UploadDocument_RESPONSE': { type: 'UploadDocumentResponse', headers: {} },

  // ============================================================================
  // EARLYSALARY LENDER APIs
  // ============================================================================
  
  'GATEWAY_LENDER|EarlySalary-ProfileIngestion Request': { endpoint: '/prof-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-ProfileIngestion_REQUEST': { endpoint: '/prof-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-ProfileIngestion Response': { type: 'ProfileIngestionResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-ProfileIngestion_RESPONSE': { type: 'ProfileIngestionResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-ProfileIngestionEncrypt Request': { endpoint: '/prof-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-ProfileIngestionEncrypt_REQUEST': { endpoint: '/prof-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-ProfileIngestionEncrypt Response': { type: 'ProfileIngestionResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-ProfileIngestionEncrypt_RESPONSE': { type: 'ProfileIngestionResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-GetToken Request': { endpoint: '/generateToken', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetToken_REQUEST': { endpoint: '/generateToken', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetToken Response': { type: 'GenerateTokenResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetToken_RESPONSE': { type: 'GenerateTokenResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-GetStatus Request': { endpoint: '/get-status', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetStatus_REQUEST': { endpoint: '/get-status', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetStatus Response': { type: 'GetStatusResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetStatus_RESPONSE': { type: 'GetStatusResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-GetStatusEncrypt Request': { endpoint: '/get-status', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetStatusEncrypt_REQUEST': { endpoint: '/get-status', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetStatusEncrypt Response': { type: 'GetStatusResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-GetStatusEncrypt_RESPONSE': { type: 'GetStatusResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-CalculateEmi Request': { endpoint: '/calculate-emi', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-CalculateEmi_REQUEST': { endpoint: '/calculate-emi', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-CalculateEmi Response': { type: 'CalculateEmiResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-CalculateEmi_RESPONSE': { type: 'CalculateEmiResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-CalculateEmiEncrypt Request': { endpoint: '/calculate-emi', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-CalculateEmiEncrypt_REQUEST': { endpoint: '/calculate-emi', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-CalculateEmiEncrypt Response': { type: 'CalculateEmiResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-CalculateEmiEncrypt_RESPONSE': { type: 'CalculateEmiResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmation Request': { endpoint: '/fetch-loan-conf', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmation_REQUEST': { endpoint: '/fetch-loan-conf', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmation Response': { type: 'LoanDisbursalConfirmationResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmation_RESPONSE': { type: 'LoanDisbursalConfirmationResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmationEncrypt Request': { endpoint: '/fetch-loan-conf', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmationEncrypt_REQUEST': { endpoint: '/fetch-loan-conf', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmationEncrypt Response': { type: 'LoanDisbursalConfirmationResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-LoanDisbursalConfirmationEncrypt_RESPONSE': { type: 'LoanDisbursalConfirmationResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-GetSettlement Request': { endpoint: '/getSettlement', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetSettlement_REQUEST': { endpoint: '/getSettlement', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetSettlement Response': { type: 'GetSettlementResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetSettlement_RESPONSE': { type: 'GetSettlementResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-GetSettlementEncrypt Request': { endpoint: '/getSettlement', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetSettlementEncrypt_REQUEST': { endpoint: '/getSettlement', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-GetSettlementEncrypt Response': { type: 'GetSettlementResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-GetSettlementEncrypt_RESPONSE': { type: 'GetSettlementResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-InitiateRefund Request': { endpoint: '/externalRefund', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-InitiateRefund_REQUEST': { endpoint: '/externalRefund', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-InitiateRefund Response': { type: 'InitiateRefundResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-InitiateRefund_RESPONSE': { type: 'InitiateRefundResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-LockTenure Request': { endpoint: '/lockTenure', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LockTenure_REQUEST': { endpoint: '/lockTenure', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LockTenure Response': { type: 'LockTenureAPIResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LockTenure_RESPONSE': { type: 'LockTenureAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-LockTenureEncrypt Request': { endpoint: '/lockTenure', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LockTenureEncrypt_REQUEST': { endpoint: '/lockTenure', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-LockTenureEncrypt Response': { type: 'LockTenureAPIResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-LockTenureEncrypt_RESPONSE': { type: 'LockTenureAPIResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatus Request': { endpoint: '/updateOrder', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatus_REQUEST': { endpoint: '/updateOrder', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatus Response': { type: 'UpdateOrderStatusAPIResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatus_RESPONSE': { type: 'UpdateOrderStatusAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatusEncrypt Request': { endpoint: '/updateOrder', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatusEncrypt_REQUEST': { endpoint: '/updateOrder', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatusEncrypt Response': { type: 'UpdateOrderStatusAPIResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-UpdateOrderStatusEncrypt_RESPONSE': { type: 'UpdateOrderStatusAPIResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-BillUpload Request': { endpoint: '/billUpload', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-BillUpload_REQUEST': { endpoint: '/billUpload', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-BillUpload Response': { type: 'BillUploadApiResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-BillUpload_RESPONSE': { type: 'BillUploadApiResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-BillUploadEncrypt Request': { endpoint: '/billUpload', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-BillUploadEncrypt_REQUEST': { endpoint: '/billUpload', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-BillUploadEncrypt Response': { type: 'BillUploadApiResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-BillUploadEncrypt_RESPONSE': { type: 'BillUploadApiResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|EarlySalary-DeactivateOrder Request': { endpoint: '/deactivate-order', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-DeactivateOrder_REQUEST': { endpoint: '/deactivate-order', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-DeactivateOrder Response': { type: 'DeactivateOrderResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-DeactivateOrder_RESPONSE': { type: 'DeactivateOrderResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUW Request': { endpoint: '/uw-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUW_REQUEST': { endpoint: '/uw-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUW Response': { type: 'MerchantConfirmationOnUWResponse', headers: {} },
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUW_RESPONSE': { type: 'MerchantConfirmationOnUWResponse', headers: {} },
  
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUWEncrypt Request': { endpoint: '/uw-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUWEncrypt_REQUEST': { endpoint: '/uw-decision', method: 'POST', service: 'EARLYSALARY', headers: {} },
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUWEncrypt Response': { type: 'MerchantConfirmationOnUWResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|EarlySalary-MerchantConfirmationOnUWEncrypt_RESPONSE': { type: 'MerchantConfirmationOnUWResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|LOAN OFFER API_REQUEST':{endpoint: '/base/flipkart/fk/loanOffer', method: 'POST', service: 'LENDER', headers: {}},
  'GATEWAY_LENDER|LOAN STATUS API_REQUEST':{endpoint: '/base/flipkart/fk/loanStatus', method: 'POST', service: 'LENDER', headers: {}},
  'GATEWAY_LENDER|OFFER API_REQUEST':{endpoint: '', method: 'POST', service: 'LENDER', headers: {}},

  // ============================================================================
  // BIMAPAY LENDER APIs
  // ============================================================================
  
  'GATEWAY_LENDER|BimaPay-Login Request': { endpoint: '/v1/partner/insurance/{urlSlug}/users/login', method: 'POST', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-Login_REQUEST': { endpoint: '/v1/partner/insurance/{urlSlug}/users/login', method: 'POST', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-Login Response': { type: 'LoginResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|BimaPay-Login_RESPONSE': { type: 'LoginResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|BimaPay-RegisterLoanApplication Request': { endpoint: '/v1/partner/insurance/{urlSlug}/users/register-loan-application', method: 'POST', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-RegisterLoanApplication_REQUEST': { endpoint: '/v1/partner/insurance/{urlSlug}/users/register-loan-application', method: 'POST', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-RegisterLoanApplication Response': { type: 'RegisterLoanApplicationResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|BimaPay-RegisterLoanApplication_RESPONSE': { type: 'RegisterLoanApplicationResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|BimaPay-LoanStatus Request': { endpoint: '/v1/partner/insurance/{urlSlug}/loans/getLoanStatus/{loanId}', method: 'GET', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-LoanStatus_REQUEST': { endpoint: '/v1/partner/insurance/{urlSlug}/loans/getLoanStatus/{loanId}', method: 'GET', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-LoanStatus Response': { type: 'LoanStatusResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|BimaPay-LoanStatus_RESPONSE': { type: 'LoanStatusResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|BimaPay-LoanDetail Request': { endpoint: '/loans/loan-data/{loanId}', method: 'GET', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-LoanDetail_REQUEST': { endpoint: '/loans/loan-data/{loanId}', method: 'GET', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-LoanDetail Response': { type: 'LoanDetailResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|BimaPay-LoanDetail_RESPONSE': { type: 'LoanDetailResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|BimaPay-LoanCancellation Request': { endpoint: '/loans/loan-cancellation', method: 'POST', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-LoanCancellation_REQUEST': { endpoint: '/loans/loan-cancellation', method: 'POST', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-LoanCancellation Response': { type: 'LoanCancellationResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|BimaPay-LoanCancellation_RESPONSE': { type: 'LoanCancellationResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|BimaPay-GetLoanCancellationDetail Request': { endpoint: '/loans/loan-cancellation/details', method: 'GET', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-GetLoanCancellationDetail_REQUEST': { endpoint: '/loans/loan-cancellation/details', method: 'GET', service: 'BIMAPAY', headers: {} },
  'GATEWAY_LENDER|BimaPay-GetLoanCancellationDetail Response': { type: 'GetLoanCancellationDetailsResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|BimaPay-GetLoanCancellationDetail_RESPONSE': { type: 'GetLoanCancellationDetailsResponse', headers: {}, encrypted: true },

  // ============================================================================
  // CIBIL BUREAU APIs
  // ============================================================================
  
  'GATEWAY_LENDER|Cibil-FulfillOffer Request': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-FulfillOffer_REQUEST': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-FulfillOffer Response': { type: 'HTTPResponse', headers: {}, xml: true },
  'GATEWAY_LENDER|Cibil-FulfillOffer_RESPONSE': { type: 'HTTPResponse', headers: {}, xml: true },
  
  'GATEWAY_LENDER|Cibil-GetAuthenticationQuestions Request': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-GetAuthenticationQuestions_REQUEST': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-GetAuthenticationQuestions Response': { type: 'HTTPResponse', headers: {}, xml: true },
  'GATEWAY_LENDER|Cibil-GetAuthenticationQuestions_RESPONSE': { type: 'HTTPResponse', headers: {}, xml: true },
  
  'GATEWAY_LENDER|Cibil-VerifyAuthenticationQuestions Request': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-VerifyAuthenticationQuestions_REQUEST': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-VerifyAuthenticationQuestions Response': { type: 'HTTPResponse', headers: {}, xml: true },
  'GATEWAY_LENDER|Cibil-VerifyAuthenticationQuestions_RESPONSE': { type: 'HTTPResponse', headers: {}, xml: true },
  
  'GATEWAY_LENDER|Cibil-GetCustomerAssets Request': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-GetCustomerAssets_REQUEST': { endpoint: '/GCCS-ws/GlobalCreditPlatformWebServicev2', method: 'POST', service: 'CIBIL', headers: {} },
  'GATEWAY_LENDER|Cibil-GetCustomerAssets Response': { type: 'HTTPResponse', headers: {}, xml: true },
  'GATEWAY_LENDER|Cibil-GetCustomerAssets_RESPONSE': { type: 'HTTPResponse', headers: {}, xml: true },

  // ============================================================================
  // EXPERIAN BUREAU APIs
  // ============================================================================
  
  'GATEWAY_LENDER|Experian-AccessToken Request': { endpoint: '/token', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-AccessToken_REQUEST': { endpoint: '/token', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-AccessToken Response': { type: 'AccessTokenResponse', headers: {} },
  'GATEWAY_LENDER|Experian-AccessToken_RESPONSE': { type: 'AccessTokenResponse', headers: {} },
  
  'GATEWAY_LENDER|Experian-ResendOtpRegistration Request': { endpoint: '/generateMobileOTP.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-ResendOtpRegistration_REQUEST': { endpoint: '/generateMobileOTP.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-ResendOtpRegistration Response': { type: 'ResendOtpRegistrationResponse', headers: {} },
  'GATEWAY_LENDER|Experian-ResendOtpRegistration_RESPONSE': { type: 'ResendOtpRegistrationResponse', headers: {} },
  
  'GATEWAY_LENDER|Experian-OtpRegistration Request': { endpoint: '/registerSingleActionMobileOTP.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-OtpRegistration_REQUEST': { endpoint: '/registerSingleActionMobileOTP.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-OtpRegistration Response': { type: 'OtpRegistrationResponse', headers: {} },
  'GATEWAY_LENDER|Experian-OtpRegistration_RESPONSE': { type: 'OtpRegistrationResponse', headers: {} },
  
  'GATEWAY_LENDER|Experian-OtpValidation Request': { endpoint: '/validateMobileOTP.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-OtpValidation_REQUEST': { endpoint: '/validateMobileOTP.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-OtpValidation Response': { type: 'OtpValidationResponse', headers: {} },
  'GATEWAY_LENDER|Experian-OtpValidation_RESPONSE': { type: 'OtpValidationResponse', headers: {} },
  
  'GATEWAY_LENDER|Experian-OnDemandService Request': { endpoint: '/onDemandRefresh.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-OnDemandService_REQUEST': { endpoint: '/onDemandRefresh.action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-OnDemandService Response': { type: 'OnDemandServiceResponse', headers: {} },
  'GATEWAY_LENDER|Experian-OnDemandService_RESPONSE': { type: 'OnDemandServiceResponse', headers: {} },
  
  'GATEWAY_LENDER|Experian-SingleAction Request': { endpoint: '/single-action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-SingleAction_REQUEST': { endpoint: '/single-action', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-SingleAction Response': { type: 'SingleActionResponse', headers: {} },
  'GATEWAY_LENDER|Experian-SingleAction_RESPONSE': { type: 'SingleActionResponse', headers: {} },
  
  'GATEWAY_LENDER|Experian-EnhancedMatch Request': { endpoint: '/enhanced-match', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-EnhancedMatch_REQUEST': { endpoint: '/enhanced-match', method: 'POST', service: 'EXPERIAN', headers: {} },
  'GATEWAY_LENDER|Experian-EnhancedMatch Response': { type: 'SingleActionResponse', headers: {} },
  'GATEWAY_LENDER|Experian-EnhancedMatch_RESPONSE': { type: 'SingleActionResponse', headers: {} },

  // ============================================================================
  // MONEYVIEW LENDER APIs
  // ============================================================================
  
  'GATEWAY_LENDER|MoneyView-GetToken Request': { endpoint: '/token', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetToken_REQUEST': { endpoint: '/token', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetToken Response': { type: 'TokenCreationResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetToken_RESPONSE': { type: 'TokenCreationResponse', headers: {} },
  
  'GATEWAY_LENDER|MoneyView-CheckLead Request': { endpoint: '/cl/check-lead', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-CheckLead_REQUEST': { endpoint: '/cl/check-lead', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-CheckLead Response': { type: 'CheckLeadResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-CheckLead_RESPONSE': { type: 'CheckLeadResponse', headers: {} },
  
  'GATEWAY_LENDER|MoneyView-CreateLead Request': { endpoint: '/lead/on-board', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-CreateLead_REQUEST': { endpoint: '/lead/on-board', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-CreateLead Response': { type: 'CreateLeadResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-CreateLead_RESPONSE': { type: 'CreateLeadResponse', headers: {} },
  
  'GATEWAY_LENDER|MoneyView-GetDrawDownOffers Request': { endpoint: '/cl/offers', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetDrawDownOffers_REQUEST': { endpoint: '/cl/offers', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetDrawDownOffers Response': { type: 'GetDrawDownOffersResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetDrawDownOffers_RESPONSE': { type: 'GetDrawDownOffersResponse', headers: {} },
  
  'GATEWAY_LENDER|MoneyView-LeadStatus Request': { endpoint: '/lead/status/{leadId}', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-LeadStatus_REQUEST': { endpoint: '/lead/status/{leadId}', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-LeadStatus Response': { type: 'LeadStatusResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-LeadStatus_RESPONSE': { type: 'LeadStatusResponse', headers: {} },
  
  'GATEWAY_LENDER|MoneyView-GetJourneyUrl Request': { endpoint: '/journey-url/{leadId}', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetJourneyUrl_REQUEST': { endpoint: '/journey-url/{leadId}', method: 'GET', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetJourneyUrl Response': { type: 'GetJourneyUrlResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-GetJourneyUrl_RESPONSE': { type: 'GetJourneyUrlResponse', headers: {} },
  
  'GATEWAY_LENDER|MoneyView-DrawDownStatus Request': { endpoint: '/cl/check-status', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-DrawDownStatus_REQUEST': { endpoint: '/cl/check-status', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-DrawDownStatus Response': { type: 'DrawDownStatusResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-DrawDownStatus_RESPONSE': { type: 'DrawDownStatusResponse', headers: {} },
  
  'GATEWAY_LENDER|MoneyView-ActivityStatus Request': { endpoint: '/lead/activity/status', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-ActivityStatus_REQUEST': { endpoint: '/lead/activity/status', method: 'POST', service: 'MONEYVIEW', headers: {} },
  'GATEWAY_LENDER|MoneyView-ActivityStatus Response': { type: 'ActivityStatusResponse', headers: {} },
  'GATEWAY_LENDER|MoneyView-ActivityStatus_RESPONSE': { type: 'ActivityStatusResponse', headers: {} },

  // ============================================================================
  // IDFC LENDER APIs
  // ============================================================================
  'GATEWAY_LENDER|IDFC-Token Request': { endpoint: '/authorization/oauth2/token', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Token_REQUEST': { endpoint: '/authorization/oauth2/token', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Token Response': { type: 'TokenAPIResponse', headers: {} },
  'GATEWAY_LENDER|IDFC-Token_RESPONSE': { type: 'TokenAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|IDFC-Eligibility Request': { endpoint: '/eligibility-check', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Eligibility_REQUEST': { endpoint: '/eligibility-check', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Eligibility Response': { type: 'EligibilityResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-Eligibility_RESPONSE': { type: 'EligibilityResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-Mandate Request': { endpoint: '/mandate-search', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Mandate_REQUEST': { endpoint: '/mandate-search', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Mandate Response': { type: 'MandateSearchResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-Mandate_RESPONSE': { type: 'MandateSearchResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-GetIFSC Request': { endpoint: '/getIFSCDetails', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-GetIFSC_REQUEST': { endpoint: '/getIFSCDetails', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-GetIFSC Response': { type: 'GetIFSCResponse[]', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-GetIFSC_RESPONSE': { type: 'GetIFSCResponse[]', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-Verification Request': { endpoint: '/verification', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Verification_REQUEST': { endpoint: '/verification', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-Verification Response': { type: 'VerificationResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-Verification_RESPONSE': { type: 'VerificationResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-SendOTP Request': { endpoint: '/generate-otp', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-SendOTP_REQUEST': { endpoint: '/generate-otp', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-SendOTP Response': { type: 'SendOTPResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-SendOTP_RESPONSE': { type: 'SendOTPResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-VerifyOTP Request': { endpoint: '/verify-otp', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-VerifyOTP_REQUEST': { endpoint: '/verify-otp', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-VerifyOTP Response': { type: 'VerifyOTPResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-VerifyOTP_RESPONSE': { type: 'VerifyOTPResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-LoanCreation Request': { endpoint: '/createloan', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-LoanCreation_REQUEST': { endpoint: '/createloan', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-LoanCreation Response': { type: 'LoanCreationResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-LoanCreation_RESPONSE': { type: 'LoanCreationResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-AutoDisbursal Request': { endpoint: '/autodisbursal', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-AutoDisbursal_REQUEST': { endpoint: '/autodisbursal', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-AutoDisbursal Response': { type: 'AutoDisbursalResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-AutoDisbursal_RESPONSE': { type: 'AutoDisbursalResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-PostDisbursal Request': { endpoint: '/post-disbursal', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-PostDisbursal_REQUEST': { endpoint: '/post-disbursal', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-PostDisbursal Response': { type: 'EligibilityResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-PostDisbursal_RESPONSE': { type: 'EligibilityResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-MandateStatus Request': { endpoint: '/emandate/verification', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-MandateStatus_REQUEST': { endpoint: '/emandate/verification', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-MandateStatus Response': { type: 'EmandateVerificationResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-MandateStatus_RESPONSE': { type: 'EmandateVerificationResponse', headers: {}, encrypted: true },
  
  'GATEWAY_LENDER|IDFC-FullCancellation Request': { endpoint: '/fullCancellation', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-FullCancellation_REQUEST': { endpoint: '/fullCancellation', method: 'POST', service: 'IDFC', headers: {} },
  'GATEWAY_LENDER|IDFC-FullCancellation Response': { type: 'FullCancellationResponse', headers: {}, encrypted: true },
  'GATEWAY_LENDER|IDFC-FullCancellation_RESPONSE': { type: 'FullCancellationResponse', headers: {}, encrypted: true },

  // ============================================================================
  // ZYPE LENDER APIs
  // ============================================================================
  
  'GATEWAY_LENDER|Zype-Dedupe Request': { endpoint: '/underwriting/bnpl/customerEligibility', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-Dedupe_REQUEST': { endpoint: '/underwriting/bnpl/customerEligibility', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-Dedupe Response': { type: 'DedupeApiResponse', headers: {} },
  'GATEWAY_LENDER|Zype-Dedupe_RESPONSE': { type: 'DedupeApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Zype-PreApproval Request': { endpoint: '/underwriting/bnpl/preApprovalOffer', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-PreApproval_REQUEST': { endpoint: '/underwriting/bnpl/preApprovalOffer', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-PreApproval Response': { type: 'PreApprovalApiResponse', headers: {} },
  'GATEWAY_LENDER|Zype-PreApproval_RESPONSE': { type: 'PreApprovalApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Zype-LeadCreation Request': { endpoint: '/bnpl/lead/create', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-LeadCreation_REQUEST': { endpoint: '/bnpl/lead/create', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-LeadCreation Response': { type: 'LeadCreationApiResponse', headers: {} },
  'GATEWAY_LENDER|Zype-LeadCreation_RESPONSE': { type: 'LeadCreationApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Zype-FetchCustomerCurrentStatus Request': { endpoint: '/fetchCustomerCurrentStatus', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-FetchCustomerCurrentStatus_REQUEST': { endpoint: '/fetchCustomerCurrentStatus', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-FetchCustomerCurrentStatus Response': { type: 'FetchCustomerCurrentStatusApiResponse', headers: {} },
  'GATEWAY_LENDER|Zype-FetchCustomerCurrentStatus_RESPONSE': { type: 'FetchCustomerCurrentStatusApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Zype-Offers Request': { endpoint: '/bnpl/partner/offers', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-Offers_REQUEST': { endpoint: '/bnpl/partner/offers', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-Offers Response': { type: 'OffersApiResponse', headers: {} },
  'GATEWAY_LENDER|Zype-Offers_RESPONSE': { type: 'OffersApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Zype-Refund Request': { endpoint: '/bnpl/product/return', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-Refund_REQUEST': { endpoint: '/bnpl/product/return', method: 'POST', service: 'ZYPE', headers: {} },
  'GATEWAY_LENDER|Zype-Refund Response': { type: 'RefundApiResponse', headers: {} },
  'GATEWAY_LENDER|Zype-Refund_RESPONSE': { type: 'RefundApiResponse', headers: {} },

  // ============================================================================
  // RAZORPAY APIs
  // ============================================================================
  
  'GATEWAY_LENDER|Razorpay-CreateCustomer Request': { endpoint: '/customers', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-CreateCustomer_REQUEST': { endpoint: '/customers', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-CreateCustomer Response': { type: 'CreateCustomerResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-CreateCustomer_RESPONSE': { type: 'CreateCustomerResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-CreateOrder Request': { endpoint: '/orders', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-CreateOrder_REQUEST': { endpoint: '/orders', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-CreateOrder Response': { type: 'CreateOrderResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-CreateOrder_RESPONSE': { type: 'CreateOrderResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-CollectAuthorizationTransaction Request': { endpoint: '/payments/create/json', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-CollectAuthorizationTransaction_REQUEST': { endpoint: '/payments/create/json', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-CollectAuthorizationTransaction Response': { type: 'CollectAuthorizationResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-CollectAuthorizationTransaction_RESPONSE': { type: 'CollectAuthorizationResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-FetchTokenViaPaymentId Request': { endpoint: '/payments/{paymentId}', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaPaymentId_REQUEST': { endpoint: '/payments/{paymentId}', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaPaymentId Response': { type: 'FetchTokenViaPaymentIdResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaPaymentId_RESPONSE': { type: 'FetchTokenViaPaymentIdResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-PaymentLink Request': { endpoint: '/payment_links', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-PaymentLink_REQUEST': { endpoint: '/payment_links', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-PaymentLink Response': { type: 'PaymentLinkResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-PaymentLink_RESPONSE': { type: 'PaymentLinkResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-FetchPayment Request': { endpoint: '/payment_links/{id}', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchPayment_REQUEST': { endpoint: '/payment_links/{id}', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchPayment Response': { type: 'FetchPaymentAPIStatusResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchPayment_RESPONSE': { type: 'FetchPaymentAPIStatusResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-FetchTokenViaCustomerId Request': { endpoint: '/customers/{customerId}/tokens', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaCustomerId_REQUEST': { endpoint: '/customers/{customerId}/tokens', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaCustomerId Response': { type: 'FetchTokenViaCustomerIdResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaCustomerId_RESPONSE': { type: 'FetchTokenViaCustomerIdResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-Subscription Request': { endpoint: '/subscription_registration/auth_links', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-Subscription_REQUEST': { endpoint: '/subscription_registration/auth_links', method: 'POST', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-Subscription Response': { type: 'SubscriptionAPIResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-Subscription_RESPONSE': { type: 'SubscriptionAPIResponse', headers: {} },
  
  'GATEWAY_LENDER|Razorpay-FetchTokenViaOrderId Request': { endpoint: '/orders/{orderId}/payments', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaOrderId_REQUEST': { endpoint: '/orders/{orderId}/payments', method: 'GET', service: 'RAZORPAY', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaOrderId Response': { type: 'FetchTokenViaOrderIdResponse', headers: {} },
  'GATEWAY_LENDER|Razorpay-FetchTokenViaOrderId_RESPONSE': { type: 'FetchTokenViaOrderIdResponse', headers: {} },

  // ============================================================================
  // PROPELLD LENDER APIs
  // ============================================================================
  
  'GATEWAY_LENDER|Propelld-CreateQuote Request': { endpoint: '/apply/generic', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-CreateQuote_REQUEST': { endpoint: '/apply/generic', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-CreateQuote Response': { type: 'CreateQuoteApiResponse', headers: {} },
  'GATEWAY_LENDER|Propelld-CreateQuote_RESPONSE': { type: 'CreateQuoteApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Propelld-EmiTable Request': { endpoint: '/emi/table', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-EmiTable_REQUEST': { endpoint: '/emi/table', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-EmiTable Response': { type: 'EmiTableApiResponse', headers: {} },
  'GATEWAY_LENDER|Propelld-EmiTable_RESPONSE': { type: 'EmiTableApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Propelld-QuoteApproval Request': { endpoint: '/quote/approve', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-QuoteApproval_REQUEST': { endpoint: '/quote/approve', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-QuoteApproval Response': { type: 'QuoteApproveApiResponse', headers: {} },
  'GATEWAY_LENDER|Propelld-QuoteApproval_RESPONSE': { type: 'QuoteApproveApiResponse', headers: {} },
  
  'GATEWAY_LENDER|Propelld-QuoteStatus Request': { endpoint: '/quote/status', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-QuoteStatus_REQUEST': { endpoint: '/quote/status', method: 'POST', service: 'PROPELLD', headers: {} },
  'GATEWAY_LENDER|Propelld-QuoteStatus Response': { type: 'QuoteStatusApiResponse', headers: {} },
  'GATEWAY_LENDER|Propelld-QuoteStatus_RESPONSE': { type: 'QuoteStatusApiResponse', headers: {} },

  // ============================================================================
  // SHOPSE LENDER APIs
  // ============================================================================
  
  'GATEWAY_LENDER|ShopSe-CheckNTBEligibility Request': { endpoint: '/v1/checkNtbEligibility', method: 'POST', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-CheckNTBEligibility_REQUEST': { endpoint: '/v1/checkNtbEligibility', method: 'POST', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-CheckNTBEligibility Response': { type: 'CheckNTBEligibilityResponse', headers: {} },
  'GATEWAY_LENDER|ShopSe-CheckNTBEligibility_RESPONSE': { type: 'CheckNTBEligibilityResponse', headers: {} },
  
  'GATEWAY_LENDER|ShopSe-EligibilityPolling Request': { endpoint: '/v1/ntbEligibilityPolling', method: 'GET', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-EligibilityPolling_REQUEST': { endpoint: '/v1/ntbEligibilityPolling', method: 'GET', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-EligibilityPolling Response': { type: 'EligibilityPollingResponse', headers: {} },
  'GATEWAY_LENDER|ShopSe-EligibilityPolling_RESPONSE': { type: 'EligibilityPollingResponse', headers: {} },
  
  'GATEWAY_LENDER|ShopSe-NTBEnquiry Request': { endpoint: '/v2/enquiry/{transactionId}', method: 'GET', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-NTBEnquiry_REQUEST': { endpoint: '/v2/enquiry/{transactionId}', method: 'GET', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-NTBEnquiry Response': { type: 'NTBEnquiryResponse', headers: {} },
  'GATEWAY_LENDER|ShopSe-NTBEnquiry_RESPONSE': { type: 'NTBEnquiryResponse', headers: {} },
  
  'GATEWAY_LENDER|ShopSe-Refund Request': { endpoint: '/v2/transactions/{transactionId}/refunds', method: 'POST', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-Refund_REQUEST': { endpoint: '/v2/transactions/{transactionId}/refunds', method: 'POST', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-Refund Response': { type: 'NTBRefundResponse', headers: {} },
  'GATEWAY_LENDER|ShopSe-Refund_RESPONSE': { type: 'NTBRefundResponse', headers: {} },
  
  'GATEWAY_LENDER|ShopSe-Constants Request': { endpoint: '/v1/profile/constants', method: 'GET', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-Constants_REQUEST': { endpoint: '/v1/profile/constants', method: 'GET', service: 'SHOPSE', headers: {} },
  'GATEWAY_LENDER|ShopSe-Constants Response': { type: 'ConstantsResponse', headers: {} },
  'GATEWAY_LENDER|ShopSe-Constants_RESPONSE': { type: 'ConstantsResponse', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibility Request': { endpoint: '/lsp/hardEligibility', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-HardEligibility_REQUEST': { endpoint: '/lsp/hardEligibility', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-GrantLoan Request': { endpoint: '/lsp/grantLoan', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-GrantLoan_REQUEST': { endpoint: '/lsp/grantLoan', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-Disbursement Request': { endpoint: '/lsp/disbursement', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-Disbursement_REQUEST': { endpoint: '/lsp/disbursement', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-FetchOffer Request': { endpoint: '/lsp/fetchOffer', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-FetchOffer_REQUEST': { endpoint: '/lsp/fetchOffer', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-SelectOffer Request': { endpoint: '/lsp/selectOffer', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-SelectOffer_REQUEST': { endpoint: '/lsp/selectOffer', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-KYC Request': { endpoint: '/lsp/kyc', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-KYC_REQUEST': { endpoint: '/lsp/kyc', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-Repayment Request': { endpoint: '/lsp/repayment', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LENDER|Themis-Repayment_REQUEST': { endpoint: '/lsp/repayment', method: 'POST', service: 'LSP', headers: {} },

  'GATEWAY_LENDER|HDB_APPLICATION_STATUS_API :: FETCH_OFFER_REQUEST':{ endpoint: '/api/v1/status-check', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_TOKEN_API_REQUEST': { endpoint: '/api/v1/authenticate-token', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_CREATE_APPLICATION_API_REQUEST': { endpoint: '/api/v1/leads', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_APPLICATION_STATUS_API_REQUEST': { endpoint: '/api/v1/status-check', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_CHECK_OFFERS_API_REQUEST': { endpoint: '/api/v1/submit-additional-data', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_OFFER_SELECTION_API_REQUEST': { endpoint: '/api/v1/asset-details', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_INITIATE_JOURNEY_API_REQUEST': { endpoint: '/api/v1/initiate-journey', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_LOAN_DISBURSEMENT_API_REQUEST': { endpoint: '/api/v1/disburse-loan', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HDB_CANCEL_LOAN_API_REQUEST': { endpoint: '/api/v1/cancel-loan', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|GRAYQUEST_REDIRECTION_BASE_API_REQUEST': { endpoint: '/api/v1/dynamic', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|GRAYQUEST_STATUS_CHECK_API_REQUEST': { endpoint: '/api/v1/applications/check-status', method: 'GET', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|GRAYQUEST_CANCEL_API_REQUEST': { endpoint: '/api/v1/applications/approval/institute-reject', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|GRAYQUEST_EMI_PLANS_API_REQUEST': { endpoint: '/api/v1/product/emi-plans', method: 'GET', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|GRAYQUEST_WEBHOOK_FETCH_API_REQUEST': { endpoint: 'misc/status', method: 'GET', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|FIBE_GENERATE_TOKEN_API_REQUEST': { endpoint: 'generateToken', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|FIBE_PROFILE_INGESTION_API_REQUEST': { endpoint: 'profileIngestion', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|PROFILE_INGESTION_REQUEST': { endpoint: 'profileIngestion', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|FIBE_CALCULATE_EMI_API_REQUEST': { endpoint: 'calculate-emi', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|FIBE_GET_REDIRECTION_URL_API_REQUEST': { endpoint: 'getredirectionurl', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|FIBE_LOCK_TENURE_API_REQUEST': { endpoint: 'lockTenure', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|FIBE_PRE_DISBURSAL_CHECK_API_REQUEST': { endpoint: 'pre-disbursal-check', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|ABFL_CREATE_TOKEN_API_REQUEST': { endpoint: 'createToken', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|ABFL_CRIF_API_REQUEST': { endpoint: 'Inquiry/doGet.service/CIRProServiceSyncXml', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|ABFL_LOAN_CANCELLATION_API_REQUEST': { endpoint: 'm2p/cancellation', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|ABFL_SPEND_AND_CONVERT_API_REQUEST': { endpoint: 'm2p/spendAndConvert', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|ABFL_MASTER_POLLING_API_REQUEST': { endpoint: 'dynamic', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|ABFL_UPSERT_API_REQUEST': { endpoint: 'dynamic', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|TVS_CHECKOUT_GENERATE_TOKEN_API_REQUEST': { endpoint: 'generateToken', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|TVS_CHECKOUT_CHECK_ELIGIBILITY_API_REQUEST': { endpoint: 'checkEligibility', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|TVS_CHECKOUT_CHECK_ELIGIBILITY_STATUS_API_REQUEST': { endpoint: 'checkEligibilityStatus', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|TVS_CHECKOUT_LOAN_STATUS_API_REQUEST': { endpoint: 'loanStatus', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|TVS_CHECKOUT_LOAN_OFFER_API_REQUEST': { endpoint: 'loanOffer', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|TVS_CHECKOUT_ACTIVATE_LOAN_API_REQUEST': { endpoint: 'loanActivation', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|TVS_CHECKOUT_REFUND_API_REQUEST': { endpoint: 'refundCancellation', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|FFPL_CANCELLATION_OAUTH_TOKEN_API_REQUEST': { endpoint: 'api/oauth/token', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|HARD_ELIGIBILITY_REQUEST': { endpoint: '/api/lazypay/cof/v0/eligibility', method: 'POST', service: 'LENDER', headers: {} },
  'GATEWAY_LENDER|CREATE APPLICATION API_REQUEST':{endpoint: '/uat/applicationcreation', method: 'POST', service: 'LENDER', headers: {}},
  'GATEWAY_LENDER|FK SCORE API_REQUEST': { endpoint: '/uat/partner_score', method: 'POST', service: 'LENDER', headers: {} },

  /// MIHURU LENDER APIs

  'GTAEWAY_LENDER|GENERATE PARTNER AUTH TOKEN_REQUEST': {endpoint: 'assistmodule/v2/login/apiuser', method: 'POST', service: 'LENDER', headers: {}},
  'CHECK ELIGIBILITY STATUS API_REQUEST':{endpoint: '/base/flipkart/fk/checkEligibilityStatus', method: 'POST', service: 'LENDER', headers: {}},

  
  // ==================== LENDER_GATEWAY (Lender to Gateway - Callbacks/Webhooks) ====================
  'LENDER_GATEWAY|WEBHOOK Request': { endpoint: '/gateway/webhook', method: 'POST', service: 'GATEWAY', headers: {} },
  'LENDER_GATEWAY|Themis-Eligibility Response': { endpoint: '/v1/themis/gateway/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-GrantLoan Response': { endpoint: '/v1/themis/grantLoan/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-Disbursement Response': { endpoint: '/v1/themis/disbursement/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-FetchOffer Response': { endpoint: '/v1/themis/fetchOffer/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-KYC Response': { endpoint: '/v1/themis/kyc/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|Themis-Repayment Response': { endpoint: '/v1/themis/repayment/response', method: 'POST', service: 'GW', headers: {} },
  'LENDER_GATEWAY|ThemisGenerateOffersResponse Response': { endpoint: '/v1/themis/offers/response', method: 'POST', service: 'GW', headers: {} },

  // ==================== GATEWAY_LSP (Gateway to LSP - Requests/Callbacks) ====================
  'GATEWAY_LSP|Themis-Eligibility_REQUEST': { endpoint: '/v1/themis/eligibility', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-Eligibility_RESPONSE': { endpoint: '/v1/themis/eligibility/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-HardEligibility_REQUEST': { endpoint: '/v1/themis/hardEligibility', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-HardEligibility_RESPONSE': { endpoint: '/v1/themis/hardEligibility/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-GrantLoan_REQUEST': { endpoint: '/v1/themis/grantLoan', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-GrantLoan_RESPONSE': { endpoint: '/v1/themis/grantLoan/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-Disbursement_REQUEST': { endpoint: '/v1/themis/disbursement', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-Disbursement_RESPONSE': { endpoint: '/v1/themis/disbursement/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-FetchOffer_REQUEST': { endpoint: '/v1/themis/fetchOffer', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-FetchOffer_RESPONSE': { endpoint: '/v1/themis/fetchOffer/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-SelectOffer_REQUEST': { endpoint: '/v1/themis/selectOffer', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|Themis-SelectOffer_RESPONSE': { endpoint: '/v1/themis/selectOffer/callback', method: 'POST', service: 'LSP', headers: {} },
  'GATEWAY_LSP|FETCH_OFFER_ASYNC_RESPONSE_REQUEST': { endpoint: "/v1.0/fetchOfferResponse", method: 'POST', service: 'LSP', headers: {}},
  'GATEWAY_LSP|FETCH_OFFER_ASYNC_RESPONSE_RESPONSE': { endpoint: "/v1.0/fetchOfferResponse", method: 'POST', service: 'LSP', headers: {}},
  'GATEWAY_LSP|LOAN_STATUS_ASYNC_RESPONSE_REQUEST': { endpoint: "/v4.0/loanStatusResponse", method: 'POST', service: 'LSP', headers: {}},
  
  // ==================== GATEWAY_THEMIS (Gateway to Themis - Forwarding) ====================
  'GATEWAY_THEMIS|Themis-KFS_REQUEST': { endpoint: '/lsp/generateKFS', method: 'POST', service: 'THEMIS', headers: {} },
  'GATEWAY_THEMIS|Themis-Eligibility_REQUEST': { endpoint: '/lsp/softEligibility', method: 'POST', service: 'THEMIS', headers: {} },
  'GATEWAY_THEMIS|Themis-Eligibility_RESPONSE': { endpoint: '/v1/themis/eligibility/forward', method: 'POST', service: 'GW', headers: {} },
  'GATEWAY_THEMIS|Themis-PriorityLogic_REQUEST': { endpoint: '/themis/v5/priorityLogic', method: 'POST', service: 'THEMIS', headers: {} },
  'GATEWAY_THEMIS|Themis-PriorityLogic_RESPONSE': { endpoint: '/v1/themis/priorityLogic/forward', method: 'POST', service: 'GW', headers: {} },
};

// API endpoint mapping: endpoint -> { logTag, api, sourceDestination, headers }
export const API_TO_LOGTAG_MAP = {
  
  
  // ── FlipKart ─────────────────────────────────────────────────────────────────
  '/flipkart/txn/eligibility/line':                          { logTag: 'FlipKart-RealTimeEligibility_REQUEST',              api: '/flipkart/txn/eligibility/line',                          sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/initiate/line/eligibility':                     { logTag: 'FlipKart-LineOnboarding-Eligibility_REQUEST',       api: '/flipkart/initiate/line/eligibility',                     sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/initiate/line/eligibility/status':              { logTag: 'FlipKart-LineOnboarding-EligibilityStatus_REQUEST', api: '/flipkart/initiate/line/eligibility/status',              sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/eligibility/lender':                       { logTag: 'FlipKart-LineOnboarding-HardEligibility_REQUEST',   api: '/flipkart/line/eligibility/lender',                       sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/eligibility/lender/status':                { logTag: 'FlipKart-LineOnboarding-HardEligibilityStatus_REQUEST', api: '/flipkart/line/eligibility/lender/status',            sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/getRedirectionUrl':                        { logTag: 'FlipKart-LineOnboarding-GetRedirectionURL_REQUEST', api: '/flipkart/line/getRedirectionUrl',                        sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/getKFS':                                   { logTag: 'FlipKart-LineOnboarding-GetKFS_REQUEST',            api: '/flipkart/line/getKFS',                                   sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/customer/line/status':                          { logTag: 'FlipKart-LineOnboarding-LineStatus_REQUEST',        api: '/flipkart/customer/line/status',                          sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/lineonboarding/eligibility':                    { logTag: 'FlipKart-LineOnboarding-Eligibility_REQUEST',       api: '/flipkart/lineonboarding/eligibility',                    sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/lineonboarding/eligibility/status':             { logTag: 'FlipKart-LineOnboarding-EligibilityStatus_REQUEST', api: '/flipkart/lineonboarding/eligibility/status',             sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/lineonboarding/eligibility/lender':             { logTag: 'FlipKart-LineOnboarding-HardEligibility_REQUEST',   api: '/flipkart/lineonboarding/eligibility/lender',             sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/lineonboarding/eligibility/lender/status':      { logTag: 'FlipKart-LineOnboarding-HardEligibilityStatus_REQUEST', api: '/flipkart/lineonboarding/eligibility/lender/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/lineonboarding/getRedirectionUrl':              { logTag: 'FlipKart-LineOnboarding-GetRedirectionURL_REQUEST', api: '/flipkart/lineonboarding/getRedirectionUrl',              sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/lineonboarding/getKFS':                         { logTag: 'FlipKart-LineOnboarding-GetKFS_REQUEST',            api: '/flipkart/lineonboarding/getKFS',                         sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility':                                   { logTag: 'FlipKart-Eligibility_REQUEST',                      api: '/flipkart/eligibility',                                   sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/status':                            { logTag: 'FlipKart-EligibilityStatus_REQUEST',                api: '/flipkart/eligibility/status',                            sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/lender':                            { logTag: 'FlipKart-HardEligibility_REQUEST',                  api: '/flipkart/eligibility/lender',                            sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/lender/status':                     { logTag: 'FlipKart-HardEligibilityStatus_REQUEST',            api: '/flipkart/eligibility/lender/status',                     sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/getKFS':                                        { logTag: 'FlipKart-GetKFS_REQUEST',                           api: '/flipkart/getKFS',                                        sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/getRedirectionUrl':                             { logTag: 'FlipKart-GetRedirectionURL_REQUEST',                api: '/flipkart/getRedirectionUrl',                             sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/txns':                                          { logTag: 'FlipKart-InitaiteTxn_REQUEST',                      api: '/flipkart/txns',                                          sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/order/status':                                  { logTag: 'FlipKart-OrderStatus_REQUEST',                      api: '/flipkart/order/status',                                  sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/refund':                                        { logTag: 'FlipKart-Refund_REQUEST',                           api: '/flipkart/refund',                                        sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/fetch/line/status':                             { logTag: 'FlipKart-LineOnboarding-FetchLineStatus_REQUEST',   api: '/flipkart/fetch/line/status',                             sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/fetch/status':                                  { logTag: 'FlipKart-FetchStatus_REQUEST',                      api: '/flipkart/fetch/status',                                  sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/createLoan':                                    { logTag: 'FlipKart-CreateLoan_REQUEST',                       api: '/flipkart/createLoan',                                    sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── FlipKart2W ───────────────────────────────────────────────────────────────
  '/flipkart2w/eligibility':              { logTag: 'Flipkart2W-Eligibility_REQUEST',           api: '/flipkart2w/eligibility',              sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/eligibility/status':       { logTag: 'Flipkart2W-EligibilityStatus_REQUEST',     api: '/flipkart2w/eligibility/status',        sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/eligibility/lender':       { logTag: 'FlipKart-2W-HardEligibility_REQUEST',      api: '/flipkart2w/eligibility/lender',        sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/eligibility/lender/status':{ logTag: 'FlipKart2W-HardEligibilityStatus_REQUEST', api: '/flipkart2w/eligibility/lender/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/getKFS':                   { logTag: 'FlipKart-GetKFS_REQUEST',                  api: '/flipkart2w/getKFS',                   sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/getRedirectionUrl':        { logTag: 'FlipKart-2W_REQUEST',                      api: '/flipkart2w/getRedirectionUrl',         sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/txns':                     { logTag: 'FlipKart2W-InitaiteTxn_REQUEST',            api: '/flipkart2w/txns',                     sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/refund':                   { logTag: 'FlipKart2W-Refund_REQUEST',                 api: '/flipkart2w/refund',                   sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/fetch/status':             { logTag: 'FlipKart2W-FetchStatus_REQUEST',            api: '/flipkart2w/fetch/status',             sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/createLoan':               { logTag: 'FlipKart2W-CreateLoan_REQUEST',             api: '/flipkart2w/createLoan',               sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/dp/create':                { logTag: 'FlipKart2W-CreatePayment_REQUEST',          api: '/flipkart2w/dp/create',                sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart2w/customer/status':          { logTag: 'FlipKart2W-CustomerStatus_REQUEST',         api: '/flipkart2w/customer/status',          sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── FlipKartSuperMoney ───────────────────────────────────────────────────────
  '/flipkartSM/getRedirectionUrl': { logTag: 'FlipKartSuperMoney-GetRedirectionURL_REQUEST', api: '/flipkartSM/getRedirectionUrl', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkartSM/txns':              { logTag: 'FlipKartSuperMoney-InitiateTxn_REQUEST',       api: '/flipkartSM/txns',              sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkartSM/order/status':      { logTag: 'FlipKart-OrderStatus_REQUEST',                 api: '/flipkartSM/order/status',      sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkartSM/refund':            { logTag: 'FlipKart-Refund_REQUEST',                      api: '/flipkartSM/refund',            sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkartSM/fetch/status':      { logTag: 'FlipKart-FetchStatus_REQUEST',                 api: '/flipkartSM/fetch/status',      sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── JuspaySDK ────────────────────────────────────────────────────────────────
  '/sdk/eligibility':              { logTag: 'JuspaySDK-SoftEligiblity_REQUEST',                    api: '/sdk/eligibility',              sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/verifyLspOtp':             { logTag: 'JuspaySDK-VerifyLspOtp_REQUEST',                      api: '/sdk/verifyLspOtp',             sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/createLoanApplication':    { logTag: 'JuspaySDK-CreateLoanApplication_REQUEST',             api: '/sdk/createLoanApplication',    sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/fetchOffer':               { logTag: 'JuspaySDK-FetchOffer-HardEligibility_REQUEST',        api: '/sdk/fetchOffer',               sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/fetchOfferStatus':         { logTag: 'JuspaySDK-FetchOfferStatus-HardEligibility-SDK_REQUEST', api: '/sdk/fetchOfferStatus',      sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/offer/set':                { logTag: 'JuspaySDK-SetOffer_REQUEST',                          api: '/sdk/offer/set',                sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/journey/url/get':          { logTag: 'JuspaySDK-GetJourneyUrl_REQUEST',                     api: '/sdk/journey/url/get',          sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/getFlowLink':              { logTag: 'GetFlowLink-SDK_REQUEST',                             api: '/sdk/getFlowLink',              sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/journey/resume':           { logTag: 'JuspaySDK-ResumeJourney_REQUEST',                     api: '/sdk/journey/resume',           sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/otp/trigger':              { logTag: 'JuspaySDK-TriggerOTP_REQUEST',                        api: '/sdk/otp/trigger',              sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/offers/generate':          { logTag: 'JuspaySDK-GenerateOffers_REQUEST',                    api: '/sdk/offers/generate',          sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/offers/get':               { logTag: 'JuspaySDK-GetOffers_REQUEST',                         api: '/sdk/offers/get',               sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/actionRequired/trigger':   { logTag: 'TriggerActionRequired_REQUEST',                       api: '/sdk/actionRequired/trigger',   sourceDestination: 'APP_WRAPPER', headers: {} },
  '/sdk/actionRequired/status':    { logTag: 'TriggerActionRequired_REQUEST',                       api: '/sdk/actionRequired/status',    sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── BusinessLoan ─────────────────────────────────────────────────────────────
  '/businessloan/customer':                    { logTag: 'BL-CreateUpdateCustomer_REQUEST',                      api: '/businessloan/customer',                    sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/customer/get':                { logTag: 'BL-GetCustomer_REQUEST',                               api: '/businessloan/customer/get',                sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/link/get':                    { logTag: 'BusinessLoan-GetLink_REQUEST',                         api: '/businessloan/link/get',                    sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/auth/verify':                 { logTag: 'BL-VerifyAuth_REQUEST',                                api: '/businessloan/auth/verify',                 sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/eligibility/soft':            { logTag: 'BusinessLoan-SoftEligibility_REQUEST',                 api: '/businessloan/eligibility/soft',            sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/eligibility/hard':            { logTag: 'BusinessLoan-HardEligibility-FetchOfferRequest_REQUEST', api: '/businessloan/eligibility/hard',          sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/eligibility/hard/status':     { logTag: 'BusinessLoan-HardEligibility-FetchOfferStatus_REQUEST', api: '/businessloan/eligibility/hard/status',   sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/loanIntent/status':           { logTag: 'BusinessLoan-LoanIntentStatus_REQUEST',                api: '/businessloan/loanIntent/status',           sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/loanApplication/status':      { logTag: 'BusinessLoan-LoanApplicationStatus_REQUEST',           api: '/businessloan/loanApplication/status',      sourceDestination: 'APP_WRAPPER', headers: {} },
  '/businessloan/getKFS':                      { logTag: 'BusinessLoan-GetKFS_REQUEST',                         api: '/businessloan/getKFS',                      sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── TSPHyperCredit ───────────────────────────────────────────────────────────
  '/tsp/order/create':    { logTag: 'TSP-Hypercredit-OrderCreate_REQUEST',  api: '/tsp/order/create',    sourceDestination: 'APP_WRAPPER', headers: {} },
  '/tsp/order/{orderId}': { logTag: 'TSP-Hypercredit-OrderStatus_REQUEST',  api: '/tsp/order/{orderId}', sourceDestination: 'APP_WRAPPER', headers: {} }, // GET
  '/tsp/refund':          { logTag: 'TSP-HyperCredit-Refund_REQUEST',       api: '/tsp/refund',          sourceDestination: 'APP_WRAPPER', headers: {} },
  '/tsp/capture':         { logTag: 'TSP-HyperCredit-Capture_REQUEST',      api: '/tsp/capture',         sourceDestination: 'APP_WRAPPER', headers: {} },
  '/tsp/eligibility':     { logTag: 'TSP-Hypercredit-Eligibility_REQUEST',  api: '/tsp/eligibility',     sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── Euler ────────────────────────────────────────────────────────────────────
  '/api/lsp/eligibility': { logTag: 'Euler-ETB-Eligibility_REQUEST', api: '/api/lsp/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── Generic / JuspaySDK (/api/) ──────────────────────────────────────────────
  '/api/eligibility': { logTag: 'JUSPAY_SDK_REQUEST', api: '/api/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/api/getKFS':      { logTag: 'JuspaySDK-GetKFS_REQUEST', api: '/api/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },

  // ── PayIn3 ───────────────────────────────────────────────────────────────────
  '/payin3/payin3/eligibility':  { logTag: 'PayIn3-SoftEligiblity_REQUEST',  api: '/payin3/payin3/eligibility',  sourceDestination: 'APP_WRAPPER', headers: {} },
  '/payin3/payin3/offer/set':    { logTag: 'JuspaySDK-SetOfferV2_REQUEST',   api: '/payin3/payin3/offer/set',    sourceDestination: 'APP_WRAPPER', headers: {} },


  // ==================== APP_WRAPPER (Wrapper Endpoints - Incoming from APP) ====================
  // FlipKart APIs
  '/flipkart/eligibility': { logTag: 'FlipKart-Eligibility_INCOMING', api: '/flipkart/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility': { logTag: 'FlipKart-Eligibility_REQUEST', api: '/flipkart/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/status': { logTag: 'FlipKart-EligibilityStatus_REQUEST', api: '/flipkart/eligibility/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/lender': { logTag: 'FlipKart-HardEligibility_REQUEST', api: '/flipkart/eligibility/lender', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/eligibility/lender/status': { logTag: 'FlipKart-HardEligibilityStatus_REQUEST', api: '/flipkart/eligibility/lender/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/getKFS': { logTag: 'FlipKart-GetKFS_REQUEST', api: '/flipkart/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/getRedirectionUrl': { logTag: 'FlipKart-GetRedirectionURL_REQUEST', api: '/flipkart/getRedirectionUrl', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/txns': { logTag: 'FlipKart-InitaiteTxn_REQUEST', api: '/flipkart/txns', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/order/status': { logTag: 'FlipKart-OrderStatus_REQUEST', api: '/flipkart/order/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/refund': { logTag: 'FlipKart-Refund_REQUEST', api: '/flipkart/refund', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/fetch/status': { logTag: 'FlipKart-FetchStatus_REQUEST', api: '/flipkart/fetch/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/createLoan': { logTag: 'FlipKart-CreateLoan_REQUEST', api: '/flipkart/createLoan', sourceDestination: 'APP_WRAPPER', headers: {} },
  
  // FlipKart Line Onboarding APIs
  '/flipkart/initiate/line/eligibility': { logTag: 'FlipKart-LineOnboarding-Eligibility_REQUEST', api: '/flipkart/initiate/line/eligibility', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/initiate/line/eligibility/status': { logTag: 'FlipKart-LineOnboarding-EligibilityStatus_REQUEST', api: '/flipkart/initiate/line/eligibility/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/eligibility/lender': { logTag: 'FlipKart-LineOnboarding-HardEligibility_REQUEST', api: '/flipkart/line/eligibility/lender', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/eligibility/lender/status': { logTag: 'FlipKart-LineOnboarding-HardEligibilityStatus_REQUEST', api: '/flipkart/line/eligibility/lender/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/getRedirectionUrl': { logTag: 'FlipKart-LineOnboarding-GetRedirectionURL_REQUEST', api: '/flipkart/line/getRedirectionUrl', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/line/getKFS': { logTag: 'FlipKart-LineOnboarding-GetKFS_REQUEST', api: '/flipkart/line/getKFS', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/customer/line/status': { logTag: 'FlipKart-LineOnboarding-LineStatus_REQUEST', api: '/flipkart/customer/line/status', sourceDestination: 'APP_WRAPPER', headers: {} },
  '/flipkart/fetch/line/status': { logTag: 'FlipKart-LineOnboarding-FetchLineStatus_REQUEST', api: '/flipkart/fetch/line/status', sourceDestination: 'APP_WRAPPER', headers: {} },
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
  // REQUEST variants (used by logs.json)
  '/credit/api/v4.0/lspotp/verify': { logTag: 'LSP-VerifyLspOtp_REQUEST', api: '/credit/api/v4.0/lspotp/verify', sourceDestination: 'APP_CORE', headers: {} },
  '/credit/api/v3.3/loan/status': { logTag: 'LSP-LoanStatus_REQUEST', api: '/credit/api/v3.3/loan/status', sourceDestination: 'APP_CORE', headers: {} },
  '/credit/api/v3.3/grantLoan': { logTag: 'LSP-GrantLoanRequest_REQUEST', api: '/credit/api/v3.3/grantLoan', sourceDestination: 'APP_CORE', headers: {} },
  '/credit/api/v5.0/getLenderFlows': { logTag: 'LSP-GetFlowLink_REQUEST', api: '/credit/api/v5.0/getLenderFlows', sourceDestination: 'APP_CORE', headers: {} },
  '/credit/api/v4.0/customer': { logTag: 'LSP-GetCustomerInfo_REQUEST', api: '/credit/api/v4.0/customer', sourceDestination: 'APP_CORE', headers: {} },
  '/credit/api/v4.0/updateCustomer': { logTag: 'LSP-UpdateCustomerInfo_REQUEST', api: '/credit/api/v4.0/updateCustomer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/triggerLspOtp': { logTag: 'LSP-TriggerLspOtp_REQUEST', api: '/api/v4.0/triggerLspOtp', sourceDestination: 'APP_CORE', headers: {} },
  // INCOMING variants (backward compatibility)
  '/api/v3.3/loanStatus-incoming': { logTag: 'LSP-LoanStatus_INCOMING', api: '/api/v3.3/loanStatus', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/grantLoan-incoming': { logTag: 'LSP-GrantLoanRequest_INCOMING', api: '/api/v3.3/grantLoan', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v5.0/getLenderFlows-incoming': { logTag: 'LSP-GetFlowLink_INCOMING', api: '/api/v5.0/getLenderFlows', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/customer-incoming': { logTag: 'LSP-GetCustomerInfo_INCOMING', api: '/api/v4.0/customer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/updateCustomer-incoming': { logTag: 'LSP-UpdateCustomerInfo_INCOMING', api: '/api/v4.0/updateCustomer', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/triggerLspOtp-incoming': { logTag: 'LSP-TriggerLspOtp_INCOMING', api: '/api/v4.0/triggerLspOtp', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v4.0/verifyLspOtp-incoming': { logTag: 'LSP-VerifyLspOtp_INCOMING', api: '/api/v4.0/verifyLspOtp', sourceDestination: 'APP_CORE', headers: {} },
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
  '/api/v3.3/offer/setOfferRequest': { logTag: 'LSP-SelectOffer_REQUEST', api: '/gateway/v1.0/selectOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/v3.3/offer/setOfferRequest': { logTag: 'LSP-SelectOffer_REQUEST', api: '/gateway/v1.0/selectOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v3.3/offer/setOfferRequest': { logTag: 'LSP-SelectOffer_REQUEST', api: '/gateway/v1.0/selectOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
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
  '/api/v4.0/getLenderFlows': {logTag: 'GetLenderFlows_REQUEST', api: '/api/v4.0/getLenderFlows', sourceDestination: 'APP_CORE', headers: {} },
  '/api/v3.3/loan/status': { logTag: 'LSP-LoanStatus_REQUEST', api: '/api/v3.3/loan/status', sourceDestination: 'APP_CORE', headers: {} },
  
  // ==================== CORE_GATEWAY (Core to Gateway/Lender - Outgoing) ====================
  '/v4.0/loanStatusResponse':{logTag: 'LOAN_STATUS_ASYNC_RESPONSE_REQUEST', api: '/v4.0/loanStatusResponse', sourceDestination: 'GATEWAY_LSP', headers: {}},
  '/v4.0/loanStatusRequest':{logTag: 'Lsp-LoanStatusRequest_REQUEST', api: '/v4.0/loanStatusRequest', sourceDestination: 'CORE_GATEWAY', headers: {}},
  '/gateway/v4.0/loanStatusRequest':{logTag: 'Lsp-LoanStatusRequest_REQUEST', api: '/v4.0/loanStatusRequest', sourceDestination: 'CORE_GATEWAY', headers: {}},
  '/v1.0/getKFS': { logTag: "LSP-GetKFS_REQUEST", api: "/gateway/v1.0/getKFS", sourceDestination: "CORE_GATEWAY", headers: {}},
  "/v1.0/fetchOfferResponse" : {logTag: "FETCH_OFFER_ASYNC_RESPONSE_REQUEST", api: "/v1.0/fetchOfferResponse", sourceDestination: "GATEWAY_LSP", headers: {}},
  '/v1.0/fetchOfferRequest' : {logTag: 'LSP-FetchOfferRequest_REQUEST', api: '/gateway/v1.0/fetchOfferRequest', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchOfferRequest' : {logTag: 'LSP-FetchOfferRequest_REQUEST', api: '/gateway/v1.0/fetchOfferRequest', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/v1.0/eligibility': { logTag: 'LSP-Eligibility_REQUEST', api: '/gateway/v1.0/eligibility', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/eligibility': { logTag: 'LSP-Eligibility_REQUEST', api: '/gateway/v1.0/eligibility', sourceDestination: 'CORE_GATEWAY', headers: {} },
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
  '/gateway/v1.0/getKFS': { logTag: 'LSP-GetKFS_REQUEST', api: '/gateway/v1.0/getKFS', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/hardEligibility': { logTag: 'LSP-HardEligibility_OUTGOING', api: '/gateway/v1.0/hardEligibility', sourceDestination: 'CORE_GATEWAY', headers: {} },
  
  // REQUEST variants (used by logs.json)
  '/gateway/v1.0/eligibility-request': { logTag: 'LSP-Eligibility_REQUEST', api: '/gateway/v1.0/eligibility', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/selectOffer-request': { logTag: 'LSP-SelectOffer_REQUEST', api: '/gateway/v1.0/selectOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createPayment-request': { logTag: 'LSP-CreatePayment_REQUEST', api: '/gateway/v1.0/createPayment', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/order-request': { logTag: 'LSP-CreateOrder_REQUEST', api: '/gateway/v1.0/order', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/refund-request': { logTag: 'LSP-RefundTriggerV2_REQUEST', api: '/gateway/v1.0/refund', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/refundStatus-request': { logTag: 'LSP-RefundStatusV2_REQUEST', api: '/gateway/v1.0/refundStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/grantLoan-request': { logTag: 'LSP-GrantLoanRequest_REQUEST', api: '/gateway/v1.0/grantLoan', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/disbursement/trigger-request': { logTag: 'LSP-TriggerDisbursementAuth_REQUEST', api: '/gateway/v1.0/disbursement/trigger', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchOffer': { logTag: 'LSP-FetchOfferRequest_REQUEST', api: '/gateway/v1.0/fetchOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchOfferStatus-request': { logTag: 'LSP-FetchOfferStatus_REQUEST', api: '/gateway/v1.0/fetchOfferStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/txnIntent-request': { logTag: 'LSP-TxnIntent_REQUEST', api: '/gateway/v1.0/txnIntent', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/txnIntentStatus-request': { logTag: 'LSP-TxnIntentStatus_REQUEST', api: '/gateway/v1.0/txnIntentStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/txnIntentUpdate-request': { logTag: 'LSP-TxnIntentUpdate_REQUEST', api: '/gateway/v1.0/txnIntentUpdate', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/fetchState-request': { logTag: 'LSP-FetchState_REQUEST', api: '/gateway/v1.0/fetchState', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/loanApplicationStatus-request': { logTag: 'LSP-LoanApplicationStatus_REQUEST', api: '/gateway/v1.0/loanApplicationStatus', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createLoanApplication-request': { logTag: 'LSP-CreateLoanApplication_REQUEST', api: '/gateway/v1.0/createLoanApplication', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createLoanRequestInfo-request': { logTag: 'LSP-CreateLoanRequestInfo_REQUEST', api: '/gateway/v1.0/createLoanRequestInfo', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/updateLoanRequestInfo-request': { logTag: 'LSP-UpdateLoanRequestInfo_REQUEST', api: '/gateway/v1.0/updateLoanRequestInfo', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/createOffer-request': { logTag: 'LSP-CreateOffer_REQUEST', api: '/gateway/v1.0/createOffer', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/getKFS-request': { logTag: 'LSP-GetKFS_REQUEST', api: '/gateway/v1.0/getKFS', sourceDestination: 'CORE_GATEWAY', headers: {} },
  '/gateway/v1.0/hardEligibility-request': { logTag: 'LSP-HardEligibility_REQUEST', api: '/gateway/v1.0/hardEligibility', sourceDestination: 'CORE_GATEWAY', headers: {} },
  
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
  
  '/lsp/generateKFS': {logTag: 'Themis-KFS_REQUEST', api: '/lsp/generateKFS', sourceDestination: 'GATEWAY_THEMIS', headers: {} },
  '/lsp/softEligibility': { logTag: 'Themis-Eligibility_REQUEST', api: '/lsp/softEligibility', sourceDestination: 'GATEWAY_THEMIS', headers: {} },
  '/lsp/hardEligibility': { logTag: 'Themis-HardEligibility_REQUEST', api: '/lsp/hardEligibility', sourceDestination: 'GATEWAY_LSP', headers: {} },
  '/lsp/grantLoan': { logTag: 'Themis-GrantLoan_REQUEST', api: '/lsp/grantLoan', sourceDestination: 'GATEWAY_LSP', headers: {} },
  '/lsp/disbursement': { logTag: 'Themis-Disbursement_REQUEST', api: '/lsp/disbursement', sourceDestination: 'GATEWAY_LSP', headers: {} },
  '/lsp/fetchOffer': { logTag: 'Themis-FetchOffer_REQUEST', api: '/lsp/fetchOffer', sourceDestination: 'GATEWAY_LSP', headers: {} },
  '/lsp/selectOffer': { logTag: 'Themis-SelectOffer_REQUEST', api: '/lsp/selectOffer', sourceDestination: 'GATEWAY_LSP', headers: {} },
  '/lsp/kyc': { logTag: 'Themis-KYC_REQUEST', api: '/lsp/kyc', sourceDestination: 'GATEWAY_LSP', headers: {} },
  '/lsp/repayment': { logTag: 'Themis-Repayment_REQUEST', api: '/lsp/repayment', sourceDestination: 'GATEWAY_LSP', headers: {} },
  
  // ==================== LENDER_GATEWAY (Lender to Gateway - Callbacks/Webhooks) ====================
  '/gateway/webhook': { logTag: 'WEBHOOK Request', api: '/gateway/webhook', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/gateway/response': { logTag: 'Themis-Eligibility Response', api: '/v1/themis/gateway/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/grantLoan/response': { logTag: 'Themis-GrantLoan Response', api: '/v1/themis/grantLoan/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/disbursement/response': { logTag: 'Themis-Disbursement Response', api: '/v1/themis/disbursement/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/fetchOffer/response': { logTag: 'Themis-FetchOffer Response', api: '/v1/themis/fetchOffer/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/kyc/response': { logTag: 'Themis-KYC Response', api: '/v1/themis/kyc/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/repayment/response': { logTag: 'Themis-Repayment Response', api: '/v1/themis/repayment/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },
  '/v1/themis/offers/response': { logTag: 'ThemisGenerateOffersResponse Response', api: '/v1/themis/offers/response', sourceDestination: 'LENDER_GATEWAY', headers: {} },

  '/base/flipkart/fk/checkEligibilityStatus': { logTag: 'CHECK ELIGIBILITY STATUS API_REQUEST', api: '/base/flipkart/fk/checkEligibilityStatus', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/api/v1/authenticate-token': {logTag: 'HDB_TOKEN_API_REQUEST', api: '/api/v1/authenticate-token', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/base/flipkart/fk/checkEligibility':{logTag: 'CHECK ELIGIBILITY API_REQUEST', api: '/base/flipkart/fk/checkEligibility', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/base/flipkart/fk/generateToken': { logTag:'GENERATE PARTNER AUTH TOKEN_REQUEST', api: '/base/flipkart/fk/generateToken', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/base/flipkart/fk/loanOffer': { logTag: 'LOAN OFFER API_REQUEST', api: '/base/flipkart/fk/loanOffer', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/base/flipkart/fk/loanStatus': { logTag: 'LOAN STATUS API_REQUEST', api: '/base/flipkart/fk/loanStatus', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/core/api/v2/workflows/ETBStatusCheck': { logTag: 'ETB_STATUS_API_REQUEST', api: '/core/api/v2/workflows/ETBStatusCheck', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/pb-uat-polling': { logTag: 'POLLING API :: LINE_STATUS_REQUEST', api: '/pb-uat-polling', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/profileIngestion': { logTag: 'PROFILE_INGESTION_REQUEST', api: '/profileIngestion', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/cselcdfkapi/1.0.0/credit-decision': { logTag: 'CREDIT_DECISION_REQUEST', api: '/cselcdfkapi/1.0.0/credit-decision', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/core/api/v2/workflows/hard-eligibility': { logTag: 'HARD_ELIGIBILITY_API_REQUEST', api: '/core/api/v2/workflows/hard-eligibility', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/api/lazypay/cof/v0/eligibility': { logTag: 'HARD_ELIGIBILITY_API_REQUEST', api: '/api/lazypay/cof/v0/eligibility', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/uat/applicationcreation':{logTag: 'CREATE APPLICATION API_REQUEST', api: '/uat/applicationcreation', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/uat/partner_score':{logTag:'FK SCORE API_REQUEST', api: '/uat/partner_score', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/api/v1/leads':{logTag: 'HDB_CREATE_APPLICATION_API_REQUEST', api: '/api/v1/leads', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/api/v1/status-check':{logTag : 'HDB_APPLICATION_STATUS_API :: FETCH_OFFER_REQUEST', api: '/api/v1/status-check', sourceDestination: 'GATEWAY_LENDER', headers: {} },
  '/api/v1/submit-additional-data':{logTag : 'HDB_CHECK_OFFERS_API_REQUEST', api: '/api/v1/submit-additional-data', sourceDestination: 'GATEWAY_LENDER', headers: {} },
};

// Destinations that should not be called (external services)
export const SKIP_DESTINATIONS = ['APP', 'LENDER', 'EULER', 'THEMIS'];

// Async/parallel API calls that can arrive out of order
// Format: { sourceDestination: string, logTagPattern: string | RegExp }
// These APIs are made in parallel by the source service and can arrive in any order
export const ASYNC_PARALLEL_APIS = [
  { sourceDestination: 'GATEWAY_LSP', logTagPattern: /^Themis-Eligibility/ },
  { sourceDestination: 'GATEWAY_THEMIS', logTagPattern: /^Themis-Eligibility/ }
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
  timeoutMs: parseInt(process.env.TIMEOUT_MS, 10) || 10000,
  autoStart: process.env.AUTO_START !== 'false'
};

// Retry configuration for stuck log entries
// RETRY_INTERVAL_MS: how often to poll (250ms = 4 times/sec)
// MAX_RETRY_SECONDS: how long to wait on the same entry before giving up
export const RETRY_CONFIG = {
  retryIntervalMs: parseInt(process.env.RETRY_INTERVAL_MS, 10) || 250,
  maxRetrySeconds: parseInt(process.env.MAX_RETRY_SECONDS, 10) || 2,
};

export const RETRY_TIMEOUT_OVERRIDES = {
  FETCH_OFFER_ASYNC_RESPONSE_REQUEST:
    parseInt(process.env.FETCH_OFFER_ASYNC_RESPONSE_MAX_RETRY_SECONDS, 10) || 90,
  'LSP-FetchOfferResponse_RESPONSE':
    parseInt(process.env.LSP_FETCH_OFFER_RESPONSE_MAX_RETRY_SECONDS, 10) || 30,
  'CHECK ELIGIBILITY STATUS API_REQUEST':
    parseInt(process.env.CHECK_ELIGIBILITY_STATUS_MAX_RETRY_SECONDS, 10) || 30,
};

export const REQUEST_TIMEOUT_OVERRIDES = {
  'FlipKart-GetKFS_REQUEST':
    parseInt(process.env.FLIPKART_GET_KFS_TIMEOUT_MS, 10) || 45000,
  'LSP-GetKFS_REQUEST':
    parseInt(process.env.LSP_GET_KFS_TIMEOUT_MS, 10) || 45000,
};

export const MOCK_CONFIG = {
  enabled: process.env.MOCK_ENABLED === 'true',
  mockLspUrl: process.env.MOCK_LSP_URL || 'http://127.0.0.1:4232',
  mockGwUrl: process.env.MOCK_GW_URL || 'http://127.0.0.1:2344'
};

export const MOCKS_ENABLED = MOCK_CONFIG.enabled;

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

function getHeaderValue(headers = {}, key) {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  return headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
}

function extractLenderOrgId(payload = {}, headers = {}) {
  return payload?.lender_org_id ||
    payload?.lenderOrgId ||
    payload?.themisDetail?.lenderOrgId ||
    payload?.eligibility?.lenderOrgId ||
    getHeaderValue(headers, 'x-lender-org-id');
}

/**
 * Get full mapping info for an API endpoint
 * @param {string} api - API endpoint path
 * @param {Object} [context]
 * @param {Object} [context.payload] - Request payload
 * @param {Object} [context.headers] - Request headers
 * @returns {Object|null} - { logTag, api, sourceDestination }
 */
export function getApiMapping(api, context = {}) {
  const mapping = API_TO_LOGTAG_MAP[api];
  if (!mapping) {
    return null;
  }

  if (api === '/lsp/generateKFS') {
    const lenderOrgId = extractLenderOrgId(context.payload, context.headers);
    if (lenderOrgId) {
      return {
        ...mapping,
        sourceDestination: 'GATEWAY_LENDER'
      };
    }
  }

  return mapping;
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

export function normalizeSourceDestination(sourceDestination, logTag) {
  const normalizedLogTag = (logTag || '').toLowerCase();
  const normalizedSD = sourceDestination.toUpperCase();

  if (normalizedLogTag.startsWith('themis-eligibility') || normalizedLogTag.startsWith('themis-kfs')) {
    return 'GATEWAY_THEMIS';
  }

  if (normalizedSD === 'GATEWAY' || normalizedSD === 'GATEWAY_CORE') {
    return 'CORE_GATEWAY';
  }

  if (normalizedSD === 'CORE_GATEWAY') {
    return 'CORE_GATEWAY';
  }

  return sourceDestination;
}

export function getEndpointConfig(sourceDestination, logTag) {
  const normalizedSD = normalizeSourceDestination(sourceDestination, logTag);

  const key = `${normalizedSD}|${logTag}`;
  if (API_TO_ENDPOINT_MAP[key]) {
    return API_TO_ENDPOINT_MAP[key];
  }

  const originalKey = `${sourceDestination}|${logTag}`;
  if (API_TO_ENDPOINT_MAP[originalKey]) {
    return API_TO_ENDPOINT_MAP[originalKey];
  }

  const remappings = {
    'APP_LSP': 'APP_WRAPPER',
    'LSP_APP': 'WRAPPER_APP'
  };
  const original = remappings[sourceDestination];
  if (original) {
    const fallbackKey = `${original}|${logTag}`;
    return API_TO_ENDPOINT_MAP[fallbackKey] || null;
  }
  return null;
}
