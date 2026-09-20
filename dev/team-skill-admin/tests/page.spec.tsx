// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { auth } from '../src/auth.ts'
import Page from '../src/app/page.tsx'
import { AdminLoginPage } from '../src/components/admin-dashboard.tsx'

vi.mock('../src/auth.ts', () => ({ auth: vi.fn() }))

afterEach(() => {
  vi.resetAllMocks()
})

describe('admin page authentication gate', () => {
  it('shows the login page when an old Auth.js session cannot be decrypted', async () => {
    vi.mocked(auth).mockRejectedValueOnce(new Error('no matching decryption secret'))

    const result = await Page()

    expect(result).toMatchObject({ type: AdminLoginPage, props: { clearStaleSession: true } })
  })
})
