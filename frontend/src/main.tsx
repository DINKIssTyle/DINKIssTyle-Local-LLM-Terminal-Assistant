/*
    Created by DINKIssTyle on 2026.
    Copyright (C) 2026 DINKI'ssTyle. All rights reserved.
*/

import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'

const container = document.getElementById('root')

const root = createRoot(container!)

root.render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>
)
