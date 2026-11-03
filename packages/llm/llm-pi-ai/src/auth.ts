/**
 * The three adapters between pi-ai's auth model and the harness credential
 * plane. Every pi-ai-specific concept stays on this side of them: the harness
 * seams they consume — `ctx.credentials` records and `ctx.authorization` flows —
 * name nothing from this library, so another adapter family can arrive with a
 * different auth model and share the same two seams. The installation device
 * id a sign-in may have to present lives here too, in a record of its own.
 *
 * @module dsh-llm-pi-ai/auth
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import type { AuthContext, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import {
  credentialKey, credentialKeyId, credentialKeyScope, credentialRef, isCredentialKeySegment, isCredentialRefName,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * The record scope every credential this adapter family stores is written
 * under. It is the plugin's registered name, which is what tells a later
 * reader — a configuration UI, or a second adapter family serving the same
 * provider name — that this plugin owns the format inside the record.
 */
export const RECORD_SCOPE = 'llm-pi-ai'

/**
 * The record address for one pi-ai provider id.
 * @param providerId - pi-ai's own provider id, which is also the harness route key.
 * @returns the scoped credential key this adapter family reads and writes.
 */
export function recordKeyFor(providerId: string): CredentialKey {
  return credentialKey(RECORD_SCOPE, providerId)
}

/**
 * The JSON image of one grant payload: plain objects lose their
 * explicitly-undefined members and array entries JSON cannot hold become
 * null, exactly as `JSON.stringify` would render them. pi-ai credentials
 * idiomatically carry optional members as explicit `undefined` (a github.com
 * Copilot grant holds `enterpriseUrl: undefined`), which the credential
 * store's strict validator refuses as unrepresentable. Everything else —
 * non-finite numbers and foreign prototypes included — passes through
 * untouched, so a genuinely unstorable value still fails loud at the store.
 * @param value - the value to render.
 * @returns the value's JSON image.
 */
function jsonImage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => entry === undefined ? null : jsonImage(entry))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const image: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) image[key] = jsonImage(member)
    }
    return image
  }
  return value
}

/**
 * Translate a stored record into the credential pi-ai expects.
 *
 * An `api-key` record is structural on both sides, so it is rebuilt field by
 * field. A `grant` payload is pi-ai's own OAuth credential, stored verbatim:
 * the seam treats it as opaque JSON precisely so a library that owns a token
 * format keeps owning it, refresh fields and all.
 * @param record - the stored record, or undefined when nothing is stored.
 * @returns the pi-ai credential, or undefined for an absent record.
 */
function toPiCredential(record: CredentialRecord | undefined): Credential | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...record.key === undefined ? {} : { key: record.key },
      ...record.env === undefined ? {} : { env: { ...record.env } },
    }
  }
  return record.payload as Credential
}

/**
 * Translate a pi-ai credential into the record to store.
 * @param credential - what a login or refresh produced.
 * @returns the record to commit, in the union the credential seam stores.
 */
function toRecord(credential: Credential): CredentialRecord {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...credential.key === undefined ? {} : { key: credential.key },
      ...credential.env === undefined ? {} : { env: { ...credential.env } },
    }
  }
  return { kind: 'grant', payload: jsonImage(credential) }
}

/**
 * The credential service, or the failure that names what is missing. Reads
 * answer "nothing stored" without a service, because a composition with no
 * credential plane genuinely holds no credential; writes refuse, because a
 * login whose grant silently evaporated would report success and then fail
 * every request.
 * @param ctx - the plugin context.
 * @returns the live service.
 * @throws {LlmError} code `NO_CREDENTIAL_STORE` when none is mounted.
 */
function writableStore(ctx: Context): CredentialProvider {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new LlmError(
      'llm-pi-ai: this composition mounts no credentials service, so there is nowhere to store the'
      + ' credential a sign-in produces; mount one (dsh-credentials-local) to sign in',
      'NO_CREDENTIAL_STORE',
    )
  }
  return credentials
}

/**
 * A pi-ai `CredentialStore` over the harness credential records.
 *
 * pi-ai runs OAuth refresh *inside* `modify()`, so this store's exclusion has
 * to cover a network round trip rather than a file rename — which is why the
 * record write path takes a wait limit of its own rather than the short one a
 * local write would need.
 *
 * pi-ai asks this store about every provider in the collection, hand-declared
 * routes included, and a route key is an arbitrary settings dict key while a
 * record id is not. An id outside the record grammar can never have stored a
 * record, so reads answer "nothing stored" and a delete has nothing to remove;
 * only `modify` refuses it, because a write that cannot land must not report
 * that it did.
 * @param ctx - the plugin context carrying the optional `ctx.credentials`.
 * @returns the store to hand `createModels()`.
 */
export function credentialStoreFrom(ctx: Context): CredentialStore {
  return {
    async read(providerId) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      if (!isCredentialKeySegment(providerId)) return undefined
      return toPiCredential(await credentials.readRecord(recordKeyFor(providerId)))
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const stored = await ctx.get('credentials')?.listRecords() ?? []
      const mine: CredentialInfo[] = []
      for (const entry of stored) {
        // Records another plugin owns are not this collection's to report:
        // their payloads are written in a format pi-ai never agreed to.
        if (credentialKeyScope(entry.key) !== RECORD_SCOPE) continue
        mine.push({
          providerId: credentialKeyId(entry.key),
          type: entry.kind === 'api-key' ? 'api_key' : 'oauth',
        })
      }
      return mine
    },
    async modify(providerId, mutate) {
      if (!isCredentialKeySegment(providerId)) {
        throw new LlmError(
          `llm-pi-ai: provider id "${providerId}" cannot address a stored credential record (a record id is a`
          + ' lowercase hyphenated identifier); authenticate this route through apiKeyEnv instead of a stored'
          + ' credential',
          'UNSTORABLE_PROVIDER_ID',
        )
      }
      const stored = await writableStore(ctx).modifyRecord(recordKeyFor(providerId), async (current) => {
        const next = await mutate(toPiCredential(current))
        return next === undefined ? undefined : toRecord(next)
      })
      return toPiCredential(stored)
    },
    // `async` so a missing service reaches the caller as a rejection: pi-ai's
    // store contract is promise-returning, and a synchronous throw would
    // escape the `ModelsError` wrapper every other storage failure gets.
    async delete(providerId) {
      if (!isCredentialKeySegment(providerId)) return
      await writableStore(ctx).deleteRecord(recordKeyFor(providerId))
    },
  }
}

/**
 * A pi-ai `AuthContext` over the harness credential plane and the host
 * filesystem.
 *
 * `env()` answers from the credential seam first, so a value a deployment
 * stored through the harness is found by a provider's own ambient discovery —
 * without this, that discovery reads only the process environment and a stored
 * `AWS_ACCESS_KEY_ID` is invisible to it. `fileExists()` answers about the host
 * process's own filesystem rather than the workspace `ctx.fs` seam, because the
 * paths it is asked about (`~/.aws/credentials`, application-default
 * credentials) are facts about where this process runs, not about the project
 * under edit.
 * @param ctx - the plugin context carrying the optional `ctx.credentials`.
 * @returns the auth context to hand `createModels()`.
 */
export function authContextFrom(ctx: Context): AuthContext {
  return {
    async env(name) {
      // pi-ai asks about arbitrary provider-declared names; one that is not a
      // POSIX identifier can never have been stored as a reference, and asking
      // the seam would throw instead of answering "not set".
      if (isCredentialRefName(name)) {
        const credentials = ctx.get('credentials')
        const hit = await credentials?.resolve(credentialRef(name))
        if (hit !== undefined) return hit.value
      }
      return launchEnvironmentOf(ctx).get(name)?.value
    },
    async fileExists(path) {
      const expanded = path.startsWith('~/') || path === '~'
        ? resolvePath(homedir(), path.slice(1).replace(/^\//, ''))
        : path
      try {
        await access(expanded)
        return true
      } catch {
        // Absent, unreadable, or a broken symlink — every one of which means
        // this ambient credential source cannot be used, which is the only
        // distinction the caller makes.
        return false
      }
    },
  }
}

/**
 * Where this installation's device id is stored. Its own scope, not
 * {@link RECORD_SCOPE}: every record under that scope is a provider route's
 * credential, listed to pi-ai and addressable by any route key, and this one
 * is neither.
 */
export const DEVICE_ID_KEY: CredentialKey = credentialKey('llm-pi-ai-installation', 'device-id')

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The id a stored device record holds, or undefined for an absent or malformed one. */
function deviceIdOf(record: CredentialRecord | undefined): string | undefined {
  if (record?.kind !== 'grant') return undefined
  const id: unknown = (record.payload as { id?: unknown } | null)?.id
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id : undefined
}

/** pi-ai's `LoginOptions.getDeviceId` for one sign-in, and the write it may start. */
export interface InstallationDeviceId {
  /**
   * The stable id of this installation: the stored one, or a new random UUID
   * that is stored on first use. Synchronous, as pi-ai calls it.
   */
  readonly get: () => string
  /** Settles once an id {@link get} created is stored; at once when it created none. */
  readonly stored: () => Promise<void>
}

/**
 * The installation device id a sign-in presents when its provider asks for
 * one (pi-ai's Sign in with ChatGPT sends it to OpenAI as the agent host id).
 *
 * One id per installation, which is one per DSH home: it lives in the home's
 * credential store, beside the grants it accompanies, and nowhere else. It is
 * read before the sign-in starts, because pi-ai asks for it synchronously, and
 * created only when a flow actually asks, so signing in to a provider that
 * never does stores nothing. Creation keeps a valid id another sign-in stored
 * in the meantime; the attempt that raced it has then presented its own once.
 * @param ctx - the plugin context carrying the optional `ctx.credentials`.
 * @returns the accessor to hand pi-ai, and the write to await after the sign-in.
 */
export async function installationDeviceId(ctx: Context): Promise<InstallationDeviceId> {
  const existing = deviceIdOf(await ctx.get('credentials')?.readRecord(DEVICE_ID_KEY))
  let created: string | undefined
  let storing: Promise<unknown> | undefined
  return {
    get() {
      if (existing !== undefined) return existing
      if (created === undefined) {
        const id = randomUUID()
        storing = writableStore(ctx).modifyRecord(DEVICE_ID_KEY, current => Promise.resolve(
          deviceIdOf(current) === undefined ? { kind: 'grant', payload: { id } } : undefined))
        // Reported by `stored()`, which the flow awaits once the sign-in settles;
        // this keeps a failure during the sign-in from counting as unhandled.
        void storing.catch(() => undefined)
        created = id
      }
      return created
    },
    async stored() {
      await storing
    },
  }
}
