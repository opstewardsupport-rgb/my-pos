import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('https://tdgcyffbblxxccsujtdy.supabase.co', 'sb_publishable_GUX0Y4Nyr-zeFAHB2IB0Xw_K7syHDWY')

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  
  // Added back business name state
  const [businessName, setBusinessName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoginMode, setIsLoginMode] = useState(false)
  const [subscribeLater, setSubscribeLater] = useState(false)
  const [discountCode, setDiscountCode] = useState('')
  const [message, setMessage] = useState('')
  const [isSuccess, setIsSuccess] = useState(false)

  useEffect(() => {
    // Check if user is already logged in or arriving via verification link
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

    // Listen for changes in authentication state (like clicking the email link)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleAuth = async (e) => {
    e.preventDefault()
    setMessage('')
    setIsSuccess(false)

    if (isLoginMode) {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setMessage(error.message)
      } else {
        setMessage('Successfully logged in!')
        setIsSuccess(true)
      }
    } else {
      // Include business name in user metadata during sign up
      const { error } = await supabase.auth.signUp({ 
        email, 
        password,
        options: {
          data: {
            business_name: businessName,
          }
        }
      })
      if (error) {
        setMessage(error.message)
      } else {
        setMessage('Registration successful! Please check your email to verify your account.')
        setIsSuccess(true)
      }
    }
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setSession(null)
  }

  // Show a loading state briefly while checking session
  if (loading) {
    return <div className="flex items-center justify-center min-h-screen bg-gray-100">Loading...</div>
  }

  // --- IF USER IS LOGGED IN (OR JUST CLICKED THE VERIFICATION LINK) ---
  if (session) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-md text-center">
          <h2 className="text-2xl font-bold mb-2 text-green-600">Welcome to your POS!</h2>
          <p className="text-gray-600 mb-1">Logged in as: {session.user.email}</p>
          {session.user.user_metadata?.business_name && (
            <p className="text-sm font-medium text-blue-600 mb-4">
              Business: {session.user.user_metadata.business_name}
            </p>
          )}
          
          <button
            onClick={handleLogout}
            className="w-full bg-red-600 text-white py-2 rounded font-semibold hover:bg-red-700"
          >
            Log Out
          </button>
        </div>
      </div>
    )
  }

  // --- REGULAR SIGN-UP / LOGIN FORM ---
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <form onSubmit={handleAuth} className="bg-white p-6 rounded shadow-md w-full max-w-sm">
        <h2 className="text-xl font-bold mb-4 text-center">
          {isLoginMode ? 'POS Login' : 'POS Sign Up'}
        </h2>

        {/* Business Name Input (Only shows on Sign Up) */}
        {!isLoginMode && (
          <input
            type="text"
            placeholder="Business Name"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            className="w-full p-2 mb-3 border rounded"
            required
          />
        )}

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
