import { createApp } from 'vue'
import { Amplify } from 'aws-amplify'
import App from './App.vue'
import outputs from '../amplify_outputs.json'

Amplify.configure(outputs)

createApp(App).mount('#app')
