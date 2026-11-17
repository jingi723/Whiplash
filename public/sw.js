// Pushes carry no payload (no message encryption on the server), so the notice is generic; the page
// passes its localized words in this script's URL.
const words = new URL(location.href).searchParams

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Whiplash', { body: words.get('body') || 'New reply', tag: 'reply', icon: '/icon-192.png' }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((open) => (open[0] ? open[0].focus() : self.clients.openWindow('/')))
  )
})
