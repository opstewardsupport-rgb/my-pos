import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('https://tdgcyffbblxxccsujtdy.supabase.co', 'sb_publishable_GUX0Y4Nyr-zeFAHB2IB0Xw_K7syHDWY')

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  
  const [businessName, setBusinessName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  
  const [isLoginMode, setIsLoginMode] = useState(false)
  const [subscribeLater, setSubscribeLater] = useState(false)
  const [discountCode, setDiscountCode] = useState('')
  const [message, setMessage] = useState('')
  const [isSuccess, setIsSuccess] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })

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
      if (password.length < 5) {
        setMessage('Password must be at least 5 characters long.')
        return
      }

      if (password !== confirmPassword) {
        setMessage('Passwords do not match. Please check and try again.')
        return
      }

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

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen bg-slate-900 text-white">Loading...</div>
  }

  if (session) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 p-4">
        <div className="bg-slate-800 border border-slate-700 p-8 rounded-xl shadow-xl w-full max-w-md text-center">
          <h2 className="text-2xl font-bold mb-2 text-emerald-400">Welcome to your POS!</h2>
          <p className="text-slate-300 mb-1">Logged in as: {session.user.email}</p>
          {session.user.user_metadata?.business_name && (
            <p className="text-sm font-medium text-indigo-400 mb-6">
              Business: {session.user.user_metadata.business_name}
            </p>
          )}
          
          <button
            onClick={handleLogout}
            className="w-full bg-rose-600 text-white py-2 rounded-lg font-semibold hover:bg-rose-700 transition"
          >
            Log Out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 p-4">
      <form onSubmit={handleAuth} className="bg-slate-800 border border-slate-700 p-8 rounded-xl shadow-xl w-full max-w-md text-slate-100">
        
        {/* OpSteward Logo and Header */}
        <div className="flex flex-col items-center mb-6">
          <div className="flex items-center space-x-2 mb-2">
            <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <span className="text-2xl font-bold tracking-wider text-white">OpSteward</span>
          </div>
          <h2 className="text-lg font-medium text-slate-300">
            {isLoginMode ? 'POS Login' : 'Create Account'}
          </h2>
        </div>

        {!isLoginMode && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-400 mb-1">BUSINESS NAME</label>
            <input
              type="text"
              placeholder="Business Name"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              className="w-full p-3 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              required
            />
          </div>
        )}

        <div className="mb-4">
          <label className="block text-xs font-semibold text-slate-400 mb-1">EMAIL ADDRESS</label>
          <input
            type="email"
            placeholder="Email Address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-3 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            required
          />
        </div>
        
        <div className="mb-4">
          <label className="block text-xs font-semibold text-slate-400 mb-1">PASSWORD</label>
          <input
            type="password"
            placeholder="Password (min 5 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-3 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            required
          />
        </div>

        {!isLoginMode && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-slate-400 mb-1">CONFIRM PASSWORD</label>
            <input
              type="password"
              placeholder="Confirm Password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full p-3 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              required
            />
          </div>
        )}

        {!isLoginMode && (
          <>
            <div className="mb-4 flex items-center space-x-2 mt-4 bg-slate-900/50 p-3 rounded-lg border border-slate-700">
              <input 
                type="checkbox" 
                id="subCheck"
                checked={subscribeLater}
                onChange={(e) => setSubscribeLater(e.target.checked)}
                className="h-4 w-4 text-indigo-600 rounded border-slate-700 bg-slate-900 focus:ring-indigo-500"
              />
              <label htmlFor="subCheck" className="text-sm text-slate-300 cursor-pointer select-none">
                Subscribe after a 3-day trial period
              </label>
            </div>

            {subscribeLater && (
              <div className="mb-4 p-3 bg-slate-900 border border-indigo-900/60 rounded-lg">
                <label className="block text-xs font-semibold text-indigo-400 mb-1">
                  DISCOUNT CODE
                </label>
                <input
                  type="text"
                  placeholder="Enter code (e.g. TRIAL3DAYS)"
                  value={discountCode}
                  onChange={(e) => setDiscountCode(e.target.value)}
                  className="w-full p-2.5 text-sm bg-slate-800 border border-slate-700 text-white rounded placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
              </div>
            )}
          </>
        )}

        <button 
          type="submit" 
          className="w-full bg-indigo-600 text-white py-3 rounded-lg font-semibold hover:bg-indigo-500 transition mt-2 mb-4 shadow-lg shadow-indigo-600/30"
        >
          {isLoginMode ? 'Log In' : 'Sign Up'}
        </button>

        <button
          type="button"
          onClick={() => {
            setIsLoginMode(!isLoginMode)
            setMessage('')
          }}
          className="w-full text-sm text-indigo-400 hover:text-indigo-300 text-center transition"
        >
          {isLoginMode ? "Don't have an account? Sign Up" : 'Already have an account? Log In'}
        </button>

        {message && (
          <p className={`mt-4 text-sm text-center font-medium ${isSuccess ? 'text-emerald-400' : 'text-indigo-300'}`}>
            {message}
          </p>
        )}
      </form>
    </div>
  )
}
