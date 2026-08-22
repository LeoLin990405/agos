import test from 'node:test'
import assert from 'node:assert/strict'
import { edgeKeySet, normalizeMemorySlug, suggestionAdopted } from './memory-slug.ts'

test('normalizeMemorySlug folds underscore and case once', () => {
  assert.equal(normalizeMemorySlug('Reference_Old'), 'reference-old')
  assert.equal(normalizeMemorySlug('  project_alpha  '), 'project-alpha')
})

test('suggestion adoption uses the same slug fold as graph edges', () => {
  const keys = edgeKeySet([
    { from: 'reference_new', to: 'reference_old' },
    { from: 'Project_Alpha', to: 'user_leo' },
  ])
  assert.equal(suggestionAdopted({ source: 'reference-new', target: 'reference_old' }, keys), true)
  assert.equal(suggestionAdopted({ source: 'project_alpha', target: 'user-leo' }, keys), true)
  assert.equal(suggestionAdopted({ source: 'reference_new', target: 'missing' }, keys), false)
})
