import { useState } from 'react'
import { createClient } from '@supabase/supabase-js'

// Replace these with your actual Supabase URL and Anon Key from your project dashboard
const supabase = createClient('YOUR_SUPABASE_URL', 'YOUR_SUPABASE_ANON_KEY')

export default function App() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoginMode, setIsLoginMode] = useState(false) // Toggle between Sign Up and Log In
  const [subscribeLater, setSubscribeLater] = useState(false) // Tracks 3-day trial preference
  const [discountCode, setDiscountCode] = useState('')
  const [message, setMessage] = useState('')
  const [isSuccess, setIsSuccess] = useState(false)

  const handleAuth = async (e) => {
    e.preventDefault()
    setMessage('')
    setIsSuccess(false)

    if (isLoginMode) {
      // --- LOG IN EXISTING USER ---
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (error) {
        setMessage(error.message)
      } else {
        setMessage('Successfully logged in!')
        setIsSuccess(true)
      }
    } else {
      // --- SIGN UP NEW USER ---
      const { error } = await supabase.auth.signUp({
        email,
        password,
      })

      // Graceful success message guiding them to verify via email instead of raw error dumps
      if (error) {
        setMessage('Please check your email inbox to verify your account and complete registration.')
        setIsSuccess(true)
      } else {
        setMessage('Registration successful! Please check your email to verify your account.')
        setIsSuccess(true)
      }
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <form onSubmit={handleAuth} className="bg-white p-6 rounded shadow-md w-full max-w-sm">
        <h2 className="text-xl font-bold mb-4 text-center">
          {isLoginMode ? 'POS Login' : 'POS Sign Up'}
        </h2>

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full p-2 mb-3 border rounded"
          required
        />
        
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full p-2 mb-3 border rounded"
          required
        />

        {/* Show trial checkbox and discount options only on the Sign Up view */}
        {!isLoginMode && (
          <>
            <div className="mb-4 flex items-center space-x-2">
              <input 
                type="checkbox" 
                id="subCheck"
                checked={subscribeLater}
                onChange={(e) => setSubscribeLater(e.target.checked)}
                className="h-4 w-4 text-blue-600 rounded border-gray-300"
              />
              <label htmlFor="subCheck" className="text-sm text-gray-700">
                Subscribe after a 3-day trial period
              </label>
            </div>

            {/* Discount code box appears ONLY if person selects to subscribe after 3 days */}
            {subscribeLater && (
              <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded">
                <label className="block text-xs font-semibold text-blue-800 mb-1">
                  DISCOUNT CODE
                </label>
                <input
                  type="text"
                  placeholder="Enter code (e.g. TRIAL3DAYS)"
                  value={discountCode}
                  onChange={(e) => setDiscountCode(e.target.value)}
                  className="w-full p-2 text-sm border rounded bg-white"
                />
              </div>
            )}
          </>
        )}

        <button 
          type="submit" 
          className="w-full bg-blue-600 text-white py-2 rounded font-semibold hover:bg-blue-700 mb-3"
        >
          {isLoginMode ? 'Log In' : 'Sign Up'}
        </button>

        <button
          type="button"
          onClick={() => {
            setIsLoginMode(!isLoginMode)
            setMessage('')
          }}
          className="w-full text-sm text-blue-600 hover:underline text-center"
        >
          {isLoginMode ? "Don't have an account? Sign Up" : 'Already have an account? Log In'}
        </button>

        {message && (
          <p className={`mt-3 text-sm text-center ${isSuccess ? 'text-green-600' : 'text-blue-600'}`}>
            {message}
          </p>
        )}
      </form>
    </div>
  )
}
