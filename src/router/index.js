import { createRouter, createWebHashHistory } from 'vue-router'
import IndexView from '@/views/index.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'index',
      component: IndexView,
    },
  ],
})

export default router
