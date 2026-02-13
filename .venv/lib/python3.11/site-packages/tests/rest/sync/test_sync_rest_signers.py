"""Pure sync tests for linking and revoking signers."""

import pytest
from eth_account import Account


@pytest.mark.skip(
    reason="Linked signers are rate limited; running repeatedly may fail."
)
def test_link_and_revoke_signer(rc, sid, sname):
    account = Account.create()
    link = rc.prepare_linked_signer(
        sender=rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    link = rc.sign_linked_signer(
        link, private_key=rc.chain.private_key, signer_private_key=account.key
    )
    res = rc.link_linked_signer(dto=link)
    assert isinstance(res, rc._models.SignerDto) and res.signer == account.address
    revoke = rc.prepare_revoke_linked_signer(
        sender=rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    revoke = rc.sign_revoke_linked_signer(revoke)
    rev_res = rc.revoke_linked_signer(dto=revoke)
    assert isinstance(rev_res, rc._models.RevokeLinkedSignerDto)


def test_prepare_linked_signer(rc_ro, sid, sname):
    account = Account.create()
    link = rc_ro.prepare_linked_signer(
        sender=rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    assert isinstance(link, rc_ro._models.LinkSignerDto)
    typed = rc_ro._models.LinkSignerDtoData.model_validate(
        link.data.model_dump(by_alias=True)
    )
    assert link.signature == "" and link.signer_signature == ""
    assert (
        typed.sender == rc_ro.chain.address
        and typed.signer == account.address
        and typed.subaccount_id == sid
    )


def test_prepare_and_sign_linked_signer_sender(rc, sid, sname):
    account = Account.create()
    link = rc.prepare_linked_signer(
        sender=rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    link = rc.sign_linked_signer(link, private_key=rc.chain.private_key)
    assert (
        isinstance(link, rc._models.LinkSignerDto)
        and link.signature != ""
        and link.signer_signature == ""
    )


def test_prepare_and_sign_linked_signer_signer(rc_ro, sid, sname):
    account = Account.create()
    link = rc_ro.prepare_linked_signer(
        sender=rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    link = rc_ro.sign_linked_signer(link, signer_private_key=account.key)
    assert (
        isinstance(link, rc_ro._models.LinkSignerDto)
        and link.signature == ""
        and link.signer_signature != ""
    )


def test_prepare_and_sign_linked_signer_both(rc, sid, sname):
    account = Account.create()
    link = rc.prepare_linked_signer(
        sender=rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    link = rc.sign_linked_signer(link, private_key=rc.chain.private_key)
    link = rc.sign_linked_signer(link, signer_private_key=account.key)
    assert (
        isinstance(link, rc._models.LinkSignerDto)
        and link.signature != ""
        and link.signer_signature != ""
        and link.signature != link.signer_signature
    )


def test_link_signer_prepares_and_signs(rc, sid, sname):
    account = Account.create()
    link = rc.link_signer(
        signer=account.address,
        subaccount_id=sid,
        signer_private_key=account.key,
        submit=False,
    )
    assert isinstance(link, rc._models.LinkSignerDto)
    assert (
        link.signature != ""
        and link.signer_signature != ""
        and link.data.subaccount_id == sid
        and link.data.subaccount == sname
    )


def test_link_signer_resolves_subaccount_from_id(rc_ro, sid, sname):
    account = Account.create()
    link = rc_ro.link_signer(
        signer=account.address,
        subaccount_id=sid,
        sign_sender=False,
        sign_signer=False,
        submit=False,
    )
    assert isinstance(link, rc_ro._models.LinkSignerDto)
    assert (
        link.signature == ""
        and link.signer_signature == ""
        and link.data.subaccount_id == sid
        and link.data.subaccount == sname
    )


def test_prepare_revoke_linked_signer(rc_ro, sid, sname):
    account = Account.create()
    revoke = rc_ro.prepare_revoke_linked_signer(
        sender=rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    assert isinstance(revoke, rc_ro._models.RevokeLinkedSignerDto)
    assert (
        revoke.data.sender == rc_ro.chain.address
        and revoke.data.signer == account.address
        and revoke.data.subaccount_id == sid
        and revoke.signature == ""
    )


def test_prepare_and_sign_revoke_linked_signer(rc, sid, sname):
    account = Account.create()
    revoke = rc.prepare_revoke_linked_signer(
        sender=rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    revoke = rc.sign_revoke_linked_signer(revoke)
    assert (
        isinstance(revoke, rc._models.RevokeLinkedSignerDto) and revoke.signature != ""
    )


def test_revoke_signer_helper(rc, sid, sname):
    account = Account.create()
    revoke = rc.revoke_signer(
        signer=account.address,
        subaccount_id=sid,
        subaccount=sname,
        submit=False,
    )
    assert isinstance(revoke, rc._models.RevokeLinkedSignerDto)
    assert (
        revoke.signature != ""
        and revoke.data.subaccount_id == sid
        and revoke.data.subaccount == sname
        and revoke.data.signer == account.address
    )


def test_prepare_refresh_linked_signer(rc_ro, sid, sname):
    account = Account.create()
    refresh = rc_ro.prepare_refresh_linked_signer(
        sender=rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    assert isinstance(refresh, rc_ro._models.RefreshLinkedSignerDto)
    assert (
        refresh.data.sender == rc_ro.chain.address
        and refresh.data.signer == account.address
        and refresh.data.subaccount_id == sid
        and refresh.signature == ""
    )


def test_prepare_and_sign_refresh_linked_signer(rc, sid, sname):
    account = Account.create()
    refresh = rc.prepare_refresh_linked_signer(
        sender=rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid,
    )
    refresh = rc.sign_refresh_linked_signer(refresh)
    assert (
        isinstance(refresh, rc._models.RefreshLinkedSignerDto)
        and refresh.signature != ""
    )


def test_refresh_signer_helper(rc, sid, sname):
    account = Account.create()
    refresh = rc.refresh_signer(
        signer=account.address,
        subaccount_id=sid,
        subaccount=sname,
        submit=False,
    )
    assert isinstance(refresh, rc._models.RefreshLinkedSignerDto)
    assert (
        refresh.signature != ""
        and refresh.data.subaccount_id == sid
        and refresh.data.subaccount == sname
        and refresh.data.signer == account.address
    )
