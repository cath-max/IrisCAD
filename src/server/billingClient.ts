import { getServiceRoleSupabaseClient } from './supabaseClient';

export type SubscriptionLevel = 'standard' | 'pro' | 'max';

export type BillingStatus = {
  user: { hasTrialed: boolean };
  subscription: {
    level: SubscriptionLevel;
    status: string | null;
    currentPeriodEnd: string | null;
  } | null;
  tokens: {
    free: number;
    subscription: number;
    purchased: number;
    total: number;
  };
};

export type ConsumeSuccess = {
  ok: true;
  tokensDeducted: number;
  freeBalance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  totalBalance: number;
};

export type ConsumeFailure = {
  ok: false;
  reason: 'insufficient_tokens';
  tokensRequired: number;
  tokensAvailable: number;
  tokensDeducted: number;
};

export type ConsumeResult = ConsumeSuccess | ConsumeFailure;

export type RefundResult = {
  ok: true;
  tokensRefunded: number;
  source: 'subscription' | 'purchased';
  freeBalance: number;
  subscriptionBalance: number;
  purchasedBalance: number;
  totalBalance: number;
};

export type BillingProduct = {
  id: string;
  stripeProductId: string;
  stripePriceId: string;
  productType: 'subscription' | 'pack';
  subscriptionLevel: SubscriptionLevel | null;
  tokenAmount: number;
  name: string;
  priceCents: number;
  interval: string | null;
  active: boolean;
};

export class BillingClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

type ConsumeBody = {
  tokens: number;
  operation?: string;
  referenceId?: string;
};

type RefundBody = {
  tokens: number;
  operation?: string;
  referenceId?: string;
};

type CheckoutBody = {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialPeriodDays?: number;
};

type CancelSubscriptionBody = {
  feedback?:
    | 'customer_service'
    | 'low_quality'
    | 'missing_features'
    | 'other'
    | 'switched_service'
    | 'too_complex'
    | 'too_expensive'
    | 'unused';
  comment?: string;
};

export type CancelSubscriptionResult =
  | { canceled: true }
  | { canceled: false; reason: 'no_subscription' | 'already_canceled' };

/** IrisCAD's launch ledger lives in this Supabase project, not adam-billing. */
async function irisCreditStatus(userId: string): Promise<BillingStatus> {
  const supabase = getServiceRoleSupabaseClient();
  const { data, error } = await supabase
    .from('iris_credit_accounts')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new BillingClientError('Could not read Iris Credits', 502, error);
  }

  const balance = data?.balance ?? 0;
  return {
    user: { hasTrialed: true },
    subscription: null,
    tokens: {
      free: balance,
      subscription: 0,
      purchased: 0,
      total: balance,
    },
  };
}

async function consumeIrisCredits(
  userId: string,
  body: ConsumeBody,
): Promise<ConsumeResult> {
  const credits = Math.max(0, Math.ceil(body.tokens));
  const supabase = getServiceRoleSupabaseClient();
  const { data, error } = await supabase.rpc('consume_iris_credits', {
    p_user_id: userId,
    p_credits: credits,
    p_operation: body.operation ?? 'ai_generation',
    p_reference_id: body.referenceId ?? null,
    p_metadata: {},
  });
  const result = data?.[0];
  if (error || !result) {
    throw new BillingClientError('Could not deduct Iris Credits', 502, error);
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: 'insufficient_tokens',
      tokensRequired: credits,
      tokensAvailable: result.credits_available,
      tokensDeducted: result.credits_deducted,
    };
  }
  return {
    ok: true,
    tokensDeducted: result.credits_deducted,
    freeBalance: result.credits_available,
    subscriptionBalance: 0,
    purchasedBalance: 0,
    totalBalance: result.credits_available,
  };
}

async function refundIrisCredits(
  userId: string,
  body: RefundBody,
): Promise<RefundResult> {
  const credits = Math.max(0, Math.ceil(body.tokens));
  const supabase = getServiceRoleSupabaseClient();
  const { data, error } = await supabase.rpc('refund_iris_credits', {
    p_user_id: userId,
    p_credits: credits,
    p_operation: body.operation ?? 'ai_refund',
    p_reference_id: body.referenceId ?? null,
    p_metadata: {},
  });
  const result = data?.[0];
  if (error || !result) {
    throw new BillingClientError('Could not refund Iris Credits', 502, error);
  }
  return {
    ok: true,
    tokensRefunded: result.credits_refunded,
    source: 'subscription',
    freeBalance: result.credits_available,
    subscriptionBalance: 0,
    purchasedBalance: 0,
    totalBalance: result.credits_available,
  };
}

export const billing = {
  getStatus(userId: string) {
    return irisCreditStatus(userId);
  },

  consume(userId: string, body: ConsumeBody) {
    return consumeIrisCredits(userId, body);
  },

  refund(userId: string, body: RefundBody) {
    return refundIrisCredits(userId, body);
  },

  createCheckout(_userId: string, _body: CheckoutBody) {
    return Promise.reject(
      new BillingClientError('IrisCAD checkout is not configured', 410, {
        error: 'checkout_unavailable',
      }),
    );
  },

  cancelSubscription(_userId: string, _body: CancelSubscriptionBody = {}) {
    return Promise.resolve<CancelSubscriptionResult>({
      canceled: false,
      reason: 'no_subscription',
    });
  },

  getProductsByType(_type: 'subscription' | 'pack') {
    return Promise.resolve<BillingProduct[]>([]);
  },

  getAllProducts() {
    return Promise.resolve({
      subscriptions: [] as BillingProduct[],
      packs: [] as BillingProduct[],
    });
  },
};
