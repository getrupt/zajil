<template>
    <div class="space-y-2">
      <h2>Create Inbox</h2>
      <input v-model="name" placeholder="Agent name" />
      <input v-model="localPart" placeholder="local-part (optional)" />
      <button @click="create">Create</button>
      <pre v-if="result">{{ result }}</pre>
    </div>
  </template>
  
  <script setup lang="ts">
  const name = ref("")
  const localPart = ref("")
  const result = ref("")
  const user = useSupabaseUser()
  const config = useRuntimeConfig()
  
  async function create() {
    // TEMP: until we have API keys & tenant mapping, pass tenant via header
    const tenantId = localStorage.getItem("tenant_id") || ""
    const res = await fetch(`${config.public.apiBase}/v1/inboxes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer dev-temp",   // Phase 0 stub
        "x-tenant-id": tenantId               // Phase 0 stub
      },
      body: JSON.stringify({ name: name.value, localPart: localPart.value || undefined })
    })
    result.value = await res.text()
  }
  </script>