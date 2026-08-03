'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Star } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

interface Testimonial {
  id: number
  client_name: string
  service_name: string | null
  rating: number | null
  body: string
  created_at: string
}

export function TestimonialModeration({ testimonial }: { testimonial: Testimonial }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function decide(approve: boolean) {
    setBusy(true)
    const supabase = createClient()

    const { error } = approve
      ? await supabase
          .from('testimonials')
          .update({ is_approved: true })
          .eq('id', testimonial.id)
      : await supabase.from('testimonials').delete().eq('id', testimonial.id)

    setBusy(false)

    if (error) {
      toast.error('Could not save that.')
      return
    }

    toast.success(approve ? 'Published.' : 'Removed.')
    router.refresh()
  }

  return (
    <div
      data-ui="panel"
      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="label-caps text-[var(--color-muted)]">
          {testimonial.client_name}
          {testimonial.service_name && ` · ${testimonial.service_name}`}
        </p>
        {testimonial.rating && (
          <span className="flex gap-0.5" aria-label={`${testimonial.rating} out of 5`}>
            {Array.from({ length: testimonial.rating }).map((_, i) => (
              <Star
                key={i}
                className="h-3 w-3 fill-[var(--color-accent)] text-[var(--color-accent)]"
              />
            ))}
          </span>
        )}
      </div>

      <p className="mt-3 text-sm leading-relaxed">{testimonial.body}</p>

      <div className="mt-5 flex gap-3">
        <Button size="sm" onClick={() => decide(true)} disabled={busy}>
          Publish
        </Button>
        <Button size="sm" variant="subtle" onClick={() => decide(false)} disabled={busy}>
          Remove
        </Button>
      </div>
    </div>
  )
}
