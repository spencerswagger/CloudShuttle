<!-- frontend/src/App.vue -->
<template>
  <nav>
    <RouterLink to="/">管道</RouterLink>
    <RouterLink to="/credentials">凭证</RouterLink>
    <RouterLink to="/images">镜像</RouterLink>
    <RouterLink to="/executions">执行</RouterLink>
  </nav>
  <RouterView />
</template>