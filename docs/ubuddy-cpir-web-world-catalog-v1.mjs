// Research-only declared model catalog. No Janus/uBuddy runtime imports.
const abstain = {id:'ABSTAIN',requiredScopes:[],cost:0,effectDelta:0,terminal:'ABSTAIN'};

export const scenarios = {
  S1_CHECKOUT: {
    publicCut:'TIMEOUT_ORDER_UNKNOWN', defaultAction:'SUBMIT_CURRENT',
    contract:{effectClass:'ORDER',requiredCardinality:1,maxCardinality:1},
    probes:[{id:'version',scope:'version.read',risk:0.1},{id:'receipt',scope:'receipt.read',risk:0.2},{id:'auth',scope:'auth.read',risk:0.1}],
    repairs:[
      {id:'SUBMIT_CURRENT',requiredScopes:['order.write'],cost:2,effectDelta:1,targetBinding:'CURRENT'},
      {id:'UPGRADE_AND_SUBMIT',requiredScopes:['order.write'],cost:3,effectDelta:1,targetBinding:'BOUND',refreshVersion:true},
      {id:'REAUTHORIZE_AND_SUBMIT',requiredScopes:['order.write'],cost:3,effectDelta:1,targetBinding:'BOUND',refreshAuth:true},
      {id:'RECONCILE',requiredScopes:[],cost:1,effectDelta:0,claimSuccess:true}, abstain
    ],
    worlds:[
      {id:'S1_VERSION_DRIFT',initialCardinality:0,binding:'BOUND',auth:'VALID',version:'STALE',reference:'VALID',scopes:['version.read','order.write'],observations:{version:'VERSION_STALE',receipt:'NO_RECEIPT',auth:'AUTH_OK'}},
      {id:'S1_COMMITTED_RECEIPT_LOST',initialCardinality:1,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['receipt.read'],observations:{version:'VERSION_CURRENT',receipt:'SINK_COMMIT_FOUND',auth:'AUTH_OK'}},
      {id:'S1_TOKEN_EXPIRED',initialCardinality:0,binding:'BOUND',auth:'EXPIRED',version:'CURRENT',reference:'VALID',scopes:['auth.read','order.write'],observations:{version:'VERSION_CURRENT',receipt:'NO_RECEIPT',auth:'AUTH_EXPIRED'}}
    ]
  },
  S2_PAYMENT: {
    publicCut:'PAYMENT_TIMEOUT_UNKNOWN', defaultAction:'RESUBMIT_ORIGINAL_KEY',
    contract:{effectClass:'CHARGE',requiredCardinality:1,maxCardinality:1},
    probes:[{id:'settlement',scope:'payment.status.read',risk:0.2}],
    repairs:[
      {id:'RESUBMIT_ORIGINAL_KEY',requiredScopes:['payment.write'],cost:2,effectDelta:1,targetBinding:'BOUND'},
      {id:'WAIT_AND_RECONCILE',requiredScopes:[],cost:1,effectDelta:0,claimSuccess:true}, abstain
    ],
    worlds:[
      {id:'S2_DROP_PRE_COMMIT',initialCardinality:0,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['payment.write','payment.status.read'],observations:{settlement:'NO_COMMIT'}},
      {id:'S2_COMMIT_STATUS_LAG',initialCardinality:1,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['payment.status.read'],observations:{settlement:'COMMIT_FOUND'}},
      {id:'S2_SCOPE_MISSING_UNKNOWN',initialCardinality:null,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['payment.write'],observations:{settlement:'UNSUPPORTED'}}
    ]
  },
  S3_CRM: {
    publicCut:'UI_SUCCESS_API_UNKNOWN', defaultAction:'SUBMIT_CURRENT',
    contract:{effectClass:'CRM_CONTACT',requiredCardinality:1,maxCardinality:1},
    probes:[{id:'subject',scope:'identity.read',risk:0.1},{id:'receipt',scope:'receipt.read',risk:0.2}],
    repairs:[
      {id:'SUBMIT_CURRENT',requiredScopes:['crm.write'],cost:2,effectDelta:1,targetBinding:'CURRENT'},
      {id:'REAUTHORIZE_AND_SUBMIT',requiredScopes:['crm.write'],cost:3,effectDelta:1,targetBinding:'BOUND',refreshAuth:true,rebindIdentity:true},
      {id:'WAIT_AND_RECONCILE',requiredScopes:[],cost:1,effectDelta:0,claimSuccess:true},
      {id:'RECOVER_RECEIPT',requiredScopes:[],cost:1.5,effectDelta:0,claimSuccess:true}, abstain
    ],
    worlds:[
      {id:'S3_WRONG_TENANT_SUBJECT',initialCardinality:0,binding:'WRONG',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['identity.read','crm.write'],observations:{subject:'SUBJECT_MISMATCH',receipt:'NO_RECEIPT'}},
      {id:'S3_WEBHOOK_DELAY',initialCardinality:1,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['identity.read','receipt.read'],observations:{subject:'SUBJECT_OK',receipt:'RECEIPT_PRESENT'}},
      {id:'S3_RECEIPT_LOST',initialCardinality:1,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['identity.read','receipt.read'],observations:{subject:'SUBJECT_OK',receipt:'SINK_ADVANCED_RECEIPT_MISSING'}}
    ]
  },
  S4_TICKET_CLOSE: {
    publicCut:'TICKET_CLOSE_UNKNOWN', defaultAction:'CLOSE_CURRENT',
    contract:{effectClass:'TICKET_CLOSE',requiredCardinality:1,maxCardinality:1},
    probes:[{id:'etag',scope:'ticket.read',risk:0.1},{id:'receipt',scope:'receipt.read',risk:0.2}],
    repairs:[
      {id:'CLOSE_CURRENT',requiredScopes:['ticket.write'],cost:2,effectDelta:1,targetBinding:'BOUND'},
      {id:'REFRESH_AND_CLOSE',requiredScopes:['ticket.write'],cost:3,effectDelta:1,targetBinding:'BOUND',refreshVersion:true},
      {id:'RECONCILE_CLOSED',requiredScopes:[],cost:1,effectDelta:0,claimSuccess:true}, abstain
    ],
    worlds:[
      {id:'S4_STALE_ETAG',initialCardinality:0,binding:'BOUND',auth:'VALID',version:'STALE',reference:'VALID',scopes:['ticket.read','ticket.write'],observations:{etag:'ETAG_STALE',receipt:'NO_RECEIPT'}},
      {id:'S4_CLOSE_COMMITTED',initialCardinality:1,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['receipt.read'],observations:{etag:'ETAG_CURRENT',receipt:'CLOSED_RECEIPT'}},
      {id:'S4_INTERVENING_UPDATE',initialCardinality:0,binding:'BOUND',auth:'VALID',version:'CHANGED',reference:'VALID',scopes:['ticket.read','ticket.write'],observations:{etag:'ETAG_CHANGED',receipt:'NO_RECEIPT'}}
    ]
  },
  S5_HR_PERMISSION: {
    publicCut:'PERMISSION_GRANT_UNKNOWN', defaultAction:'GRANT_CURRENT',
    contract:{effectClass:'PERMISSION_GRANT',requiredCardinality:1,maxCardinality:1},
    probes:[{id:'scope',scope:'identity.read',risk:0.1},{id:'employee',scope:'identity.read',risk:0.1},{id:'receipt',scope:'audit.read',risk:0.2}],
    repairs:[
      {id:'GRANT_CURRENT',requiredScopes:['permission.write'],cost:2,effectDelta:1,targetBinding:'CURRENT'},
      {id:'REAUTHORIZE_AND_GRANT',requiredScopes:['permission.write'],cost:3,effectDelta:1,targetBinding:'BOUND',refreshAuth:true},
      {id:'REBIND_AND_GRANT',requiredScopes:['permission.write'],cost:3,effectDelta:1,targetBinding:'BOUND',rebindIdentity:true},
      {id:'WAIT_AND_RECONCILE',requiredScopes:[],cost:1,effectDelta:0,claimSuccess:true}, abstain
    ],
    worlds:[
      {id:'S5_SCOPE_EXPIRED',initialCardinality:0,binding:'BOUND',auth:'EXPIRED',version:'CURRENT',reference:'VALID',scopes:['identity.read','permission.write'],observations:{scope:'SCOPE_EXPIRED',employee:'EMPLOYEE_OK',receipt:'NO_AUDIT'}},
      {id:'S5_GRANT_COMMITTED',initialCardinality:1,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['identity.read','audit.read'],observations:{scope:'SCOPE_OK',employee:'EMPLOYEE_OK',receipt:'GRANT_RECEIPT'}},
      {id:'S5_WRONG_ALIAS',initialCardinality:0,binding:'WRONG',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['identity.read','permission.write'],observations:{scope:'SCOPE_OK',employee:'EMPLOYEE_MISMATCH',receipt:'NO_AUDIT'}}
    ]
  },
  S6_REFUND: {
    publicCut:'REFUND_TIMEOUT_UNKNOWN', defaultAction:'SUBMIT_REFUND_CURRENT',
    contract:{effectClass:'REFUND',requiredCardinality:1,maxCardinality:1},
    probes:[{id:'ledger',scope:'refund.read',risk:0.2},{id:'reference',scope:'payment.read',risk:0.1},{id:'version',scope:'refund.read',risk:0.1}],
    repairs:[
      {id:'SUBMIT_REFUND_CURRENT',requiredScopes:['refund.write'],cost:2,effectDelta:1,targetBinding:'BOUND'},
      {id:'FIX_REFERENCE_AND_SUBMIT',requiredScopes:['refund.write'],cost:3,effectDelta:1,targetBinding:'BOUND',fixReference:true},
      {id:'RECONCILE_REFUND',requiredScopes:[],cost:1,effectDelta:0,claimSuccess:true}, abstain
    ],
    worlds:[
      {id:'S6_REFUND_REJECTED',initialCardinality:0,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'INVALID',scopes:['refund.read','payment.read','refund.write'],observations:{ledger:'REFUND_REJECTED',reference:'REFERENCE_INVALID',version:'BALANCE_CURRENT'}},
      {id:'S6_REFUND_COMMITTED',initialCardinality:1,binding:'BOUND',auth:'VALID',version:'CURRENT',reference:'VALID',scopes:['refund.read','payment.read'],observations:{ledger:'REFUND_COMMITTED',reference:'REFERENCE_OK',version:'BALANCE_CURRENT'}},
      {id:'S6_BALANCE_DRIFT',initialCardinality:0,binding:'BOUND',auth:'VALID',version:'CHANGED',reference:'VALID',scopes:['refund.read','payment.read','refund.write'],observations:{ledger:'NO_REFUND',reference:'REFERENCE_OK',version:'BALANCE_DRIFT'}}
    ]
  }
};
