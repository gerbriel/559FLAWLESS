import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * Newsletter subscription management API
 * 
 * POST /api/newsletter/subscribe - Subscribe to newsletter (with double opt-in)
 * POST /api/newsletter/confirm - Confirm subscription from email link
 * POST /api/newsletter/unsubscribe - Unsubscribe via token from email
 */

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const { action, email, token, source, utm_source, utm_medium, utm_campaign } = body

  if (action === 'subscribe') {
    if (!email) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('subscribe_newsletter', {
      p_email: email.toLowerCase().trim(),
      p_source: source || 'footer',
      p_utm_source: utm_source || null,
      p_utm_medium: utm_medium || null,
      p_utm_campaign: utm_campaign || null,
      p_referrer: request.headers.get('referer') || null,
    })

    if (error) {
      console.error('Newsletter subscription error:', error)
      return NextResponse.json({ error: 'Subscription failed' }, { status: 500 })
    }

    return NextResponse.json(data)
  }

  if (action === 'confirm') {
    if (!token) {
      return NextResponse.json({ error: 'Token required' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('confirm_newsletter', {
      p_token: token,
    })

    if (error) {
      console.error('Newsletter confirmation error:', error)
      return NextResponse.json({ error: 'Confirmation failed' }, { status: 500 })
    }

    return NextResponse.json(data)
  }

  if (action === 'unsubscribe') {
    if (!token) {
      return NextResponse.json({ error: 'Token required' }, { status: 400 })
    }

    const { data, error } = await supabase.rpc('unsubscribe_newsletter', {
      p_token: token,
    })

    if (error) {
      console.error('Newsletter unsubscribe error:', error)
      return NextResponse.json({ error: 'Unsubscribe failed' }, { status: 500 })
    }

    return NextResponse.json(data)
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}
