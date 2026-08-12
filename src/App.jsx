import { useState, useEffect } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient('https://tdgcyffbblxxccsujtdy.supabase.co', 'sb_publishable_GUX0Y4Nyr-zeFAHB2IB0Xw_K7syHDWY')

// Using your exact uploaded logo link directly:
const logoImage = "https://i.ibb.co/pBTM7RQv/Gemini-Generated-Image-gzijxcgzijxcgzij-removebg-preview.png"

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
    return <div className="flex items-center justify-center min-h-screen bg-[#f1f3f5] text-slate-700 font-medium">Loading...</div>
  }

  if (session) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-[#f7f8f9] to-[#e2e5e9] p-4">
        <div className="bg-[#ffffff] border border-[#d1d5db] p-8 rounded-2xl shadow-2xl shadow-slate-400/20 w-full max-w-md text-center">
          <h2 className="text-2xl font-bold mb-2 text-slate-800">Welcome to your POS!</h2>
          <p className="text-slate-600 mb-1">Logged in as: {session.user.email}</p>
          {session.user.user_metadata?.business_name && (
            <p className="text-sm font-semibold text-slate-500 mb-6 tracking-wide uppercase">
              Business: {session.user.user_metadata.business_name}
            </p>
          )}
          
          <button
            onClick={handleLogout}
            className="w-full bg-slate-800 text-slate-100 py-3 rounded-xl font-semibold hover:bg-slate-700 transition shadow-md"
          >
            Log Out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-[#f7f8f9] to-[#d8dbdf] p-4 text-slate-800">
      <form onSubmit={handleAuth} className="bg-[#ffffff] border border-[#d1d5db] p-8 rounded-2xl shadow-2xl shadow-slate-400/25 w-full max-w-md">
        
        {/* Your Exact Logo Image Header */}
        <div className="flex flex-col items-center mb-6">
          <div className="bg-white p-2 rounded-xl shadow-sm border border-slate-100 mb-2 flex justify-center">
            <img 
              src={logoImage} 
              alt="OpSteward Logo" 
              className="w-44 h-auto object-contain block"
            />
          </div>
          <h2 className="text-xs font-bold tracking-widest text-slate-500 uppercase mt-1">
            {isLoginMode ? 'POS Login' : 'Create Account'}
          </h2>
        </div>

        {!isLoginMode && (
          <div className="mb-4">
            <label className="block text-xs font-bold text-slate-500 mb-1 tracking-wider">BUSINESS NAME</label>
            <input
              type="text"
              placeholder="Business Name"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              className="w-full p-3 bg-[#f8f9fa] border border-[#d1d5db] rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-500 focus:bg-white transition"
              required
            />
          </div>
        )}

        <div className="mb-4">
          <label className="block text-xs font-bold text-slate-500 mb-1 tracking-wider">EMAIL ADDRESS</label>
          <input
            type="email"
            placeholder="Email Address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-3 bg-[#f8f9fa] border border-[#d1d5db] rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-500 focus:bg-white transition"
            required
          />
        </div>
        
        <div className="mb-4">
          <label className="block text-xs font-bold text-slate-500 mb-1 tracking-wider">PASSWORD</label>
          <input
            type="password"
            placeholder="Password (min 5 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-3 bg-[#f8f9fa] border border-[#d1d5db] rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-500 focus:bg-white transition"
            required
          />
        </div>

        {!isLoginMode && (
          <div className="mb-4">
            <label className="block text-xs font-bold text-slate-500 mb-1 tracking-wider">CONFIRM PASSWORD</label>
            <input
              type="password"
              placeholder="Confirm Password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full p-3 bg-[#f8f9fa] border border-[#d1d5db] rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:border-slate-500 focus:bg-white transition"
              required
            />
          </div>
        )}

        {!isLoginMode && (
          <>
            <div className="mb-4 flex items-center space-x-2.5 mt-4 bg-[#f8f9fa] p-3.5 rounded-xl border border-[#d1d5db]">
              <input 
                type="checkbox" 
                id="subCheck"
                checked={subscribeLater}
                onChange={(e) => setSubscribeLater(e.target.checked)}
                className="h-4 w-4 text-slate-800 rounded border-slate-300 bg-white focus:ring-slate-500 accent-slate-800"
              />
              <label htmlFor="subCheck" className="text-sm font-medium text-slate-700 cursor-pointer select-none">
                Subscribe after a 3-day trial period
              </label>
            </div>

            {subscribeLater && (
              <div className="mb-4 p-3.5 bg-[#f8f9fa] border border-[#cbd5e1] rounded-xl">
                <label className="block text-xs font-bold text-slate-600 mb-1 tracking-wider">
                  DISCOUNT CODE
                </label>
                <input
                  type="text"
                  placeholder="Enter code (e.g. TRIAL3DAYS)"
                  value={discountCode}
                  onChange={(e) => setDiscountCode(e.target.value)}
                  className="w-full p-2.5 text-sm bg-white border border-[#d1d5db] text-slate-900 rounded-lg placeholder-slate-400 focus:outline-none focus:border-slate-500"
                />
              </div>
            )}
          </>
        )}

        <button 
          type="submit" 
          className="w-full bg-slate-900 text-white py-3.5 rounded-xl font-bold hover:bg-slate-800 transition mt-2 mb-4 shadow-lg shadow-slate-500/20 tracking-wide"
        >
          {isLoginMode ? 'Log In' : 'Sign Up'}
        </button>

        <button
          type="button"
          onClick={() => {
            setIsLoginMode(!isLoginMode)
            setMessage('')
          }}
          className="w-full text-sm font-medium text-slate-600 hover:text-slate-900 text-center transition"
        >
          {isLoginMode ? "Don't have an account? Sign Up" : 'Already have an account? Log In'}
        </button>

        {message && (
          <p className={`mt-4 text-sm text-center font-medium ${isSuccess ? 'text-emerald-600' : 'text-rose-600'}`}>
            {message}
          </p>
        )}
      </form>
    </div>
  )
}
