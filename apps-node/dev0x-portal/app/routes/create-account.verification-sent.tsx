import { useLoaderData } from '@remix-run/react';
import type { LoaderArgs } from '@remix-run/server-runtime';
import { json, redirect } from '@remix-run/server-runtime';
import { getSignedInUser, sessionStorage } from '../auth.server';
import { AppBar } from '../components/AppBar';

export async function loader({ request }: LoaderArgs) {
    const [user, headers] = await getSignedInUser(request);

    if (user) {
        throw redirect('/apps', { headers: headers || new Headers() });
    }
    const multiformSession = await sessionStorage.getSession(request.headers.get('Cookie'));

    if (!multiformSession.has('verifyEmail')) {
        throw redirect('/');
    }
    return json({
        email: multiformSession.get('verifyEmail').email as string,
    });
}

export default function VerificationSent() {
    const loaderData = useLoaderData<{ email: string }>();

    return (
        <main className="bg-white h-screen min-h-screen w-full flex flex-col">
            <AppBar />
            <div className=" h-full w-full flex justify-center">
                <div className="w-full max-w-[456px] mt-40">
                    <h1 className="text-2.5xl text-black mb-4">First, let's verify your email</h1>
                    <p className="mb-3">
                        Check <b>{loaderData.email}</b> to verify your account and get started.
                    </p>
                    <p className="mb-6">
                        If you need help,{' '}
                        <a href="#" className="text-blue">
                            visit support
                        </a>{' '}
                        or{' '}
                        <a href="#" className="text-blue">
                            contact us
                        </a>
                    </p>
                    <button type="submit" className="col-span-2 bg-grey-200 text-black rounded-xl py-4 w-full">
                        Resend email
                    </button>
                </div>
            </div>
        </main>
    );
}
