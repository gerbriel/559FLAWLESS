'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input, Label, Field, Select } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatMoney, formatDuration, initials } from '@/lib/utils'
import { Search, AlertTriangle } from 'lucide-react'

interface Service {
  id: number
  name: string
  slug: string
  price_cents: number
  duration_minutes: number
  requires_age_verification: boolean
  requires_consultation: boolean
}

interface Provider {
  id: string
  first_name: string | null
  last_name: string | null
  timezone: string
}

interface ClientProfile {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
}

interface Props {
  services: Service[]
  providers: Provider[]
  preselectedClient?: ClientProfile
}

interface TimeSlot {
  time: string
  display: string
}

export function StaffBookingForm({ services, providers, preselectedClient }: Props) {
  const router = useRouter()
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<ClientProfile[]>([])
  const [selectedClient, setSelectedClient] = useState<ClientProfile | null>(preselectedClient ?? null)
  // Staff can book several services as one visit, the same as a client can.
  const [serviceIds, setServiceIds] = useState<number[]>([])
  const [providerId, setProviderId] = useState<string | null>(null)
  const [selectedAddonIds, setSelectedAddonIds] = useState<number[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [availableSlots, setAvailableSlots] = useState<TimeSlot[]>([])
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null)
  const [clientNotes, setClientNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formWarnings, setFormWarnings] = useState<string[]>([])
  const [loadingSlots, setLoadingSlots] = useState(false)

  // Search for clients
  useEffect(() => {
    if (!searchTerm.trim()) {
      setSearchResults([])
      return
    }

    const search = async () => {
      const supabase = createClient()
      const term = `%${searchTerm.trim()}%`
      
      const { data } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, email, phone')
        .eq('role', 'client')
        .or(`first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`)
        .limit(10)

      setSearchResults(data ?? [])
    }

    const timer = setTimeout(search, 300)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // Check form requirements when client and service are selected
  useEffect(() => {
    if (!selectedClient || serviceIds.length === 0) {
      setFormWarnings([])
      return
    }

    const checkRequirements = async () => {
      const supabase = createClient()
      const chosen = services.filter(s => serviceIds.includes(s.id))
      if (chosen.length === 0) return

      const warnings: string[] = []

      // The strictest service sets the rule for the whole visit.
      if (chosen.some(s => s.requires_age_verification)) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('age_verified_at')
          .eq('id', selectedClient.id)
          .maybeSingle()

        if (!profile?.age_verified_at) {
          warnings.push('This service requires age verification. Client has not verified their age.')
        }
      }

      // Check for active consent forms
      const { data: consents } = await supabase
        .from('consent_signatures')
        .select('expires_at')
        .eq('client_id', selectedClient.id)
        .order('signed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!consents) {
        warnings.push('No consent forms on file. Client should complete required forms before their appointment.')
      } else if (consents.expires_at && new Date(consents.expires_at) < new Date()) {
        warnings.push('Consent forms have expired. Client needs to re-sign before treatment.')
      }

      // Check for consultation requirement
      if (chosen.some(s => s.requires_consultation)) {
        const { data: prevAppointments, count } = await supabase
          .from('appointments')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', selectedClient.id)
          .eq('status', 'completed')

        if ((count ?? 0) === 0) {
          warnings.push('This service requires a consultation. This appears to be a new client.')
        }
      }

      setFormWarnings(warnings)
    }

    checkRequirements()
  }, [selectedClient, serviceIds, services])

  // Fetch available slots when service, provider, and date are selected
  useEffect(() => {
    if (serviceIds.length === 0 || !providerId || !selectedDate) {
      setAvailableSlots([])
      return
    }

    const fetchSlots = async () => {
      setLoadingSlots(true)
      try {
        if (serviceIds.length === 0) return

        // The route takes provider/service/from/days — not
        // providerId/serviceId/date. With the wrong names it 400'd every time,
        // so no slots ever appeared and staff could not pick a time at all.
        const params = new URLSearchParams({
          provider: providerId,
          service: serviceIds.join(','),
          from: selectedDate,
          days: '1',
        })
        const response = await fetch(`/api/availability?${params}`)

        if (!response.ok) {
          throw new Error('Failed to fetch availability')
        }

        const data = await response.json()
        // Response shape is { days: [{ date, slots: ISO[] }] }.
        const day = (data.days ?? []).find(
          (d: { date: string }) => d.date === selectedDate
        )
        setAvailableSlots(day?.slots ?? [])
      } catch (err) {
        console.error('Error fetching slots:', err)
        setAvailableSlots([])
      } finally {
        setLoadingSlots(false)
      }
    }

    fetchSlots()
  }, [serviceIds, providerId, selectedDate, services])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!selectedClient || serviceIds.length === 0 || !providerId || !selectedSlot) {
      setError('Please complete all required fields')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/book/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: selectedClient.id,
          serviceIds,
          providerId,
          startsAt: selectedSlot,
          addonIds: selectedAddonIds,
          notes: clientNotes.trim() || null,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.message || data.error || 'Booking failed')
      }

      router.push(`/dashboard/appointments/${data.booking.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create booking')
    } finally {
      setLoading(false)
    }
  }

  const chosenServices = services.filter(s => serviceIds.includes(s.id))
  // Totals for the visit — additive in time and money.
  const totalPriceCents = chosenServices.reduce((n, s) => n + s.price_cents, 0)
  const totalMinutes = chosenServices.reduce((n, s) => n + s.duration_minutes, 0)
  const selectedProvider = providers.find(p => p.id === providerId)

  // Generate next 30 days for date selection
  const availableDates = Array.from({ length: 30 }, (_, i) => {
    const date = new Date()
    date.setDate(date.getDate() + i)
    return {
      value: date.toISOString().split('T')[0],
      label: date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    }
  })

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Client Selection */}
      <Card>
        <CardHeader>
          <CardTitle>1. Select Client</CardTitle>
        </CardHeader>
        <CardContent>
          {selectedClient ? (
            <div className="flex items-center justify-between border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-[var(--color-border)] text-xs">
                  {initials(selectedClient.first_name, selectedClient.last_name)}
                </div>
                <div>
                  <p className="font-medium">
                    {selectedClient.first_name} {selectedClient.last_name}
                  </p>
                  <p className="text-sm text-[var(--color-muted)]">
                    {selectedClient.email}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelectedClient(null)}
              >
                Change
              </Button>
            </div>
          ) : (
            <div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" />
                <Input
                  type="search"
                  placeholder="Search by name, email, or phone..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              
              {searchResults.length > 0 && (
                <ul className="mt-2 divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
                  {searchResults.map((client) => (
                    <li key={client.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedClient(client)
                          setSearchTerm('')
                        }}
                        className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-[var(--color-surface)]"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-xs">
                          {initials(client.first_name, client.last_name)}
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {client.first_name} {client.last_name}
                          </p>
                          <p className="text-xs text-[var(--color-muted)]">
                            {client.email}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {searchTerm && searchResults.length === 0 && (
                <p className="mt-2 text-sm text-[var(--color-muted)]">
                  No clients found. <Button variant="ghost" size="sm" type="button">Create new client profile</Button>
                </p>
              )}
            </div>
          )}

          {formWarnings.length > 0 && selectedClient && (
            <div className="mt-4 space-y-2">
              {formWarnings.map((warning, i) => (
                <div key={i} className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <p>{warning}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Service & Provider Selection */}
      <Card>
        <CardHeader>
          <CardTitle>2. Select Service & Provider</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Service" htmlFor="service">
            <div className="max-h-64 space-y-1 overflow-y-auto border border-[var(--color-border)] p-2">
              {services.map((service) => {
                const on = serviceIds.includes(service.id)
                return (
                  <label
                    key={service.id}
                    className="flex cursor-pointer items-center gap-3 p-2 text-sm hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setServiceIds((cur) =>
                          on ? cur.filter((id) => id !== service.id) : [...cur, service.id]
                        )
                      }
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span className="flex-1">
                      {service.name}
                      <span className="ml-2 text-xs text-[var(--color-muted)]">
                        {formatMoney(service.price_cents)} ·{' '}
                        {formatDuration(service.duration_minutes)}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </Field>

          <Field label="Provider" htmlFor="provider">
            <Select
              id="provider"
              value={providerId ?? ''}
              onChange={(e) => setProviderId(e.target.value || null)}
              required
            >
              <option value="">Select a provider...</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.first_name} {provider.last_name}
                </option>
              ))}
            </Select>
          </Field>

          {chosenServices.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone="neutral">
                {chosenServices.length}{' '}
                {chosenServices.length === 1 ? 'service' : 'services'} ·{' '}
                {formatDuration(totalMinutes)} · {formatMoney(totalPriceCents)}
              </Badge>
              {/* One gated service gates the visit. */}
              {chosenServices.some((s) => s.requires_age_verification) && (
                <Badge tone="info">Requires age verification</Badge>
              )}
              {chosenServices.some((s) => s.requires_consultation) && (
                <Badge tone="info">Requires consultation</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Date & Time Selection */}
      {serviceIds.length > 0 && providerId && (
        <Card>
          <CardHeader>
            <CardTitle>3. Select Date & Time</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Date" htmlFor="date">
              <Select
                id="date"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value)
                  setSelectedSlot(null)
                }}
                required
              >
                <option value="">Select a date...</option>
                {availableDates.map((date) => (
                  <option key={date.value} value={date.value}>
                    {date.label}
                  </option>
                ))}
              </Select>
            </Field>

            {selectedDate && (
              <div>
                <Label>Available Time Slots</Label>
                {loadingSlots ? (
                  <p className="mt-2 text-sm text-[var(--color-muted)]">Loading slots...</p>
                ) : availableSlots.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--color-muted)]">
                    No availability for this date. Try a different date.
                  </p>
                ) : (
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {availableSlots.map((slot) => (
                      <button
                        key={slot.time}
                        type="button"
                        onClick={() => setSelectedSlot(slot.time)}
                        className={`border px-3 py-2 text-sm transition-colors ${
                          selectedSlot === slot.time
                            ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                            : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
                        }`}
                      >
                        {slot.display}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Notes */}
      {selectedSlot && (
        <Card>
          <CardHeader>
            <CardTitle>4. Additional Notes (Optional)</CardTitle>
          </CardHeader>
          <CardContent>
            <Field label="Client Notes" htmlFor="notes" hint="Any special requests or notes for this appointment">
              <Input
                id="notes"
                value={clientNotes}
                onChange={(e) => setClientNotes(e.target.value)}
                placeholder="e.g., First time client, sensitive skin..."
              />
            </Field>
          </CardContent>
        </Card>
      )}

      {/* Submit */}
      {selectedSlot && (
        <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-6">
          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Creating Booking...' : 'Create Booking'}
            </Button>
          </div>
        </div>
      )}
    </form>
  )
}
