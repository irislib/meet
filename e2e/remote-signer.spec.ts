import { expect, test } from '@playwright/test';

test('remote signer belongs to the existing account screen and cancellation returns there', async ({ page }) => {
  await page.goto('/');
  const signer = page.getByRole('button', { name: 'Sign in with remote signer' });
  await expect(signer).toHaveCount(0);
  await page.getByRole('button', { name: 'Already have an account?' }).click();
  await signer.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in with remote signer' });
  await expect(dialog.getByLabel('Signer connection link')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(signer).toBeVisible();
});

test('restored meeting identity signs and encrypts using its paired account', async ({ page }) => {
  const { generateSecretKey, getPublicKey, finalizeEvent, nip44, verifyEvent } = await import('nostr-tools')
  const owner = generateSecretKey()
  const transport = generateSecretKey()
  const methods: string[] = []
  await page.routeWebSocket(/^wss:\/\/signer\.test/, socket => {
    let subscription: string
    socket.onMessage(raw => {
      const [type, value] = JSON.parse(raw.toString())
      if (type === 'REQ') { subscription = value; return }
      if (type !== 'EVENT') return
      expect(verifyEvent(value)).toBe(true)
      socket.send(JSON.stringify(['OK', value.id, true, '']))
      const key = nip44.v2.utils.getConversationKey(transport, value.pubkey)
      const { id, method, params } = JSON.parse(nip44.v2.decrypt(value.content, key))
      methods.push(method)
      let result: string
      switch (method) {
        case 'connect': result = 'ack'; break
        case 'switch_relays': result = 'null'; break
        case 'get_public_key': result = getPublicKey(owner); break
        case 'sign_event': result = JSON.stringify(finalizeEvent(JSON.parse(params[0]), owner)); break
        case 'nip44_encrypt': result = nip44.v2.encrypt(params[1], nip44.v2.utils.getConversationKey(owner, params[0])); break
        case 'nip44_decrypt': result = nip44.v2.decrypt(params[1], nip44.v2.utils.getConversationKey(owner, params[0])); break
        default: throw new Error('Unexpected signer method')
      }
      const response = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now()/1000), tags: [['p', value.pubkey]],
        content: nip44.v2.encrypt(JSON.stringify({ id, result }), key) }, transport)
      socket.send(JSON.stringify(['EVENT', subscription, response]))
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Already have an account?' }).click()
  await page.getByRole('button', { name: 'Sign in with remote signer' }).click()
  await page.getByLabel('Signer connection link').fill(`bunker://${getPublicKey(transport)}?relay=wss://signer.test&secret=one-time-token`)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  const home = page.getByRole('heading', { name: 'Start a Meeting' })
  await expect(home).toBeVisible()
  await page.reload()
  await expect(home).toBeVisible()
  await expect(page.getByRole('button', { name: 'Already have an account?' })).toHaveCount(0)
  const { signature, clear, saved } = await page.evaluate(async () => {
    // Vite serves the same runtime modules consumed by the meeting session.
    const { identity } = await import('/src/lib/identity.ts')
    const { encryptForPeer, decryptFromPeer } = await import('/src/lib/encryption.ts')
    let current
    const unsubscribe = identity.subscribe(value => { current = value })
    unsubscribe()
    const encrypted = await encryptForPeer({ message: 'private meeting' }, current.pubkey)
    return {
      signature: await current.signer.signEvent({ kind: 1, tags: [], content: 'meeting test', created_at: 100 }),
      clear: await decryptFromPeer(encrypted, current.pubkey),
      saved: localStorage.getItem('iris-meet-identity'),
    }
  })
  expect(verifyEvent(signature)).toBe(true)
  expect(signature.pubkey).toBe(getPublicKey(owner))
  expect(clear).toEqual({ message: 'private meeting' })
  expect(saved).not.toContain('one-time-token')
  expect(methods.filter(method => method === 'connect')).toHaveLength(1)
})
