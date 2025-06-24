
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405,
      headers: corsHeaders 
    });
  }

  try {
    const url = new URL(req.url);
    const txRef = url.searchParams.get('tx_ref');
    const status = url.searchParams.get('status');
    const transactionId = url.searchParams.get('transaction_id');

    if (!txRef) {
      throw new Error('Missing transaction reference');
    }

    console.log('Verifying subscription:', { txRef, status, transactionId });

    // Use service role client for admin operations
    const supabaseService = createClient(supabaseUrl, supabaseServiceKey);

    // Verify payment with Flutterwave
    const flutterwaveResponse = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('FLUTTERWAVE_SECRET_KEY')}`,
        'Content-Type': 'application/json'
      }
    });

    const verificationResult = await flutterwaveResponse.json();
    console.log('Flutterwave verification result:', verificationResult);

    if (verificationResult.status !== 'success' || verificationResult.data.status !== 'successful') {
      throw new Error('Payment verification failed');
    }

    const paymentData = verificationResult.data;

    // Get subscription record
    const { data: subscription, error: subscriptionError } = await supabaseService
      .from('subscriptions')
      .select('*')
      .eq('flutterwave_tx_ref', txRef)
      .single();

    if (subscriptionError || !subscription) {
      console.error('Subscription not found:', subscriptionError);
      throw new Error('Subscription not found');
    }

    console.log('Found subscription:', subscription);

    // Extract user info from payment metadata
    const customerEmail = paymentData.customer.email;
    const customerName = paymentData.customer.name;
    const planType = paymentData.meta?.plan_type || subscription.plan_type;
    const isTrial = paymentData.meta?.is_trial === true;

    // Check if user already exists
    let userId = subscription.user_id;
    
    if (!userId) {
      // Get user from pending user data or create account
      const pendingUserData = paymentData.meta?.pending_user_data;
      
      if (pendingUserData) {
        try {
          // Create user account
          const { data: authData, error: authError } = await supabaseService.auth.admin.createUser({
            email: customerEmail,
            password: pendingUserData.password,
            email_confirm: true,
            user_metadata: {
              full_name: customerName
            }
          });

          if (authError) {
            console.error('User creation error:', authError);
            throw new Error('Failed to create user account');
          }

          userId = authData.user.id;
          console.log('Created user:', userId);

        } catch (error) {
          console.error('Error creating user:', error);
          throw new Error('Failed to create user account');
        }
      } else {
        throw new Error('No user data found');
      }
    }

    // Update subscription with user_id and mark as active
    const { error: updateSubscriptionError } = await supabaseService
      .from('subscriptions')
      .update({
        user_id: userId,
        status: 'active',
        flutterwave_subscription_id: paymentData.id?.toString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', subscription.id);

    if (updateSubscriptionError) {
      console.error('Failed to update subscription:', updateSubscriptionError);
      throw new Error('Failed to update subscription');
    }

    // Update user profile with plan information
    const { error: updateProfileError } = await supabaseService
      .from('profiles')
      .update({
        plan_type: planType,
        subscription_status: isTrial ? 'trial' : 'active',
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (updateProfileError) {
      console.error('Failed to update profile:', updateProfileError);
      // Don't throw here as the main subscription is already created
    }

    // Create transaction record
    const { error: transactionError } = await supabaseService
      .from('transactions')
      .insert({
        user_id: userId,
        flutterwave_tx_ref: txRef,
        flutterwave_tx_id: paymentData.id?.toString(),
        amount: paymentData.amount,
        currency: paymentData.currency,
        status: 'completed',
        customer_email: customerEmail,
        customer_name: customerName,
        payment_method: paymentData.payment_type,
        plan_fee_rate: getPlanFeeRate(planType)
      });

    if (transactionError) {
      console.error('Failed to create transaction record:', transactionError);
      // Don't throw here as the main subscription is already created
    }

    // Create notification for successful subscription
    const { error: notificationError } = await supabaseService
      .from('notifications')
      .insert({
        user_id: userId,
        type: 'payment',
        title: 'Subscription Activated',
        message: isTrial 
          ? `Your ${planType} plan trial has started! You have 7 days to try all features.`
          : `Your ${planType} plan subscription is now active. Welcome to PayLockr!`,
        metadata: {
          plan_type: planType,
          subscription_id: subscription.id,
          is_trial: isTrial
        }
      });

    if (notificationError) {
      console.error('Failed to create notification:', notificationError);
      // Don't throw here as the main subscription is already created
    }

    console.log('Subscription verification completed successfully');

    return new Response(JSON.stringify({
      success: true,
      subscription_id: subscription.id,
      user_id: userId,
      plan_type: planType,
      is_trial: isTrial,
      message: 'Subscription verified and activated successfully'
    }), {
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });

  } catch (error) {
    console.error('Subscription verification error:', error);
    return new Response(JSON.stringify({ 
      error: 'Subscription verification failed',
      details: error.message 
    }), { 
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  }
});

function getPlanFeeRate(planType: string): number {
  const feeRates = {
    starter: 0.05,
    professional: 0.03,
    enterprise: 0.01
  };
  
  return feeRates[planType] || 0.05;
}
