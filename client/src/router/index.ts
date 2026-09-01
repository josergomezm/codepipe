import { createRouter, createWebHistory } from 'vue-router'
import ChatView from '../views/ChatView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/actions',
      name: 'actions',
      component: () => import('../views/ActionsView.vue'),
    },
    {
      path: '/board',
      name: 'board',
      component: () => import('../views/IdeasBoardView.vue'),
    },
    {
      path: '/ledger',
      name: 'ledger',
      component: () => import('../views/LedgerView.vue'),
    },
    // Chat stays the catch-all so existing deep links (/?session=<id>) and
    // unknown paths land in the conversation view.
    {
      path: '/:catchAll(.*)',
      name: 'chat',
      component: ChatView,
    },
  ],
})

export default router
