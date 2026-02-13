"""Pure async tests for linking and revoking signers."""

import pytest
from eth_account import Account


@pytest.mark.skip(
    reason="Linked signers are rate limited; running repeatedly may fail."
)
@pytest.mark.asyncio
async def test_link_and_revoke_signer(async_rc, async_subaccount, network):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    link = await async_rc.prepare_linked_signer(
        sender=async_rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    link = await async_rc.sign_linked_signer(
        link, private_key=async_rc.chain.private_key, signer_private_key=account.key
    )
    res = await async_rc.link_linked_signer(dto=link)
    assert isinstance(res, async_rc._models.SignerDto) and res.signer == account.address
    revoke = await async_rc.prepare_revoke_linked_signer(
        sender=async_rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    revoke = await async_rc.sign_revoke_linked_signer(revoke)
    rev_res = await async_rc.revoke_linked_signer(dto=revoke)
    assert isinstance(rev_res, async_rc._models.RevokeLinkedSignerDto)


@pytest.mark.asyncio
async def test_prepare_linked_signer(async_rc_ro, async_subaccount, network):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    link = await async_rc_ro.prepare_linked_signer(
        sender=async_rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    assert isinstance(link, async_rc_ro._models.LinkSignerDto)
    typed = async_rc_ro._models.LinkSignerDtoData.model_validate(
        link.data.model_dump(by_alias=True)
    )
    assert link.signature == "" and link.signer_signature == ""
    assert (
        typed.sender == async_rc_ro.chain.address
        and typed.signer == account.address
        and typed.subaccount_id == sid_any
    )


@pytest.mark.asyncio
async def test_prepare_and_sign_linked_signer_sender(
    async_rc, async_subaccount, network
):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    link = await async_rc.prepare_linked_signer(
        sender=async_rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    link = await async_rc.sign_linked_signer(
        link, private_key=async_rc.chain.private_key
    )
    assert (
        isinstance(link, async_rc._models.LinkSignerDto)
        and link.signature != ""
        and link.signer_signature == ""
    )


@pytest.mark.asyncio
async def test_prepare_and_sign_linked_signer_signer(
    async_rc_ro, async_subaccount, network
):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    link = await async_rc_ro.prepare_linked_signer(
        sender=async_rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    link = await async_rc_ro.sign_linked_signer(link, signer_private_key=account.key)
    assert (
        isinstance(link, async_rc_ro._models.LinkSignerDto)
        and link.signature == ""
        and link.signer_signature != ""
    )


@pytest.mark.asyncio
async def test_prepare_and_sign_linked_signer_both(async_rc, async_subaccount, network):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    link = await async_rc.prepare_linked_signer(
        sender=async_rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    link = await async_rc.sign_linked_signer(
        link, private_key=async_rc.chain.private_key
    )
    link = await async_rc.sign_linked_signer(link, signer_private_key=account.key)
    assert (
        isinstance(link, async_rc._models.LinkSignerDto)
        and link.signature != ""
        and link.signer_signature != ""
        and link.signature != link.signer_signature
    )


@pytest.mark.asyncio
async def test_link_signer_prepares_and_signs(async_rc, async_subaccount, network):
    account = Account.create()
    link = await async_rc.link_signer(
        signer=account.address,
        subaccount_id=async_subaccount.id,
        signer_private_key=account.key,
        submit=False,
    )
    assert isinstance(link, async_rc._models.LinkSignerDto)
    assert (
        link.signature != ""
        and link.signer_signature != ""
        and link.data.subaccount_id == async_subaccount.id
        and link.data.subaccount == async_subaccount.name
    )


@pytest.mark.asyncio
async def test_link_signer_resolves_subaccount_from_id(
    async_rc_ro, async_subaccount, network
):
    account = Account.create()
    link = await async_rc_ro.link_signer(
        signer=account.address,
        subaccount_id=async_subaccount.id,
        sign_sender=False,
        sign_signer=False,
        submit=False,
    )
    assert isinstance(link, async_rc_ro._models.LinkSignerDto)
    assert (
        link.signature == ""
        and link.signer_signature == ""
        and link.data.subaccount_id == async_subaccount.id
        and link.data.subaccount == async_subaccount.name
    )


@pytest.mark.asyncio
async def test_prepare_revoke_linked_signer(async_rc_ro, async_subaccount, network):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    revoke = await async_rc_ro.prepare_revoke_linked_signer(
        sender=async_rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    assert isinstance(revoke, async_rc_ro._models.RevokeLinkedSignerDto)
    assert (
        revoke.data.sender == async_rc_ro.chain.address
        and revoke.data.signer == account.address
        and revoke.data.subaccount_id == sid_any
        and revoke.signature == ""
    )


@pytest.mark.asyncio
async def test_prepare_and_sign_revoke_linked_signer(
    async_rc, async_subaccount, network
):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    revoke = await async_rc.prepare_revoke_linked_signer(
        sender=async_rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    revoke = await async_rc.sign_revoke_linked_signer(revoke)
    assert (
        isinstance(revoke, async_rc._models.RevokeLinkedSignerDto)
        and revoke.signature != ""
    )


@pytest.mark.asyncio
async def test_revoke_signer_helper(async_rc, async_subaccount, network):
    account = Account.create()
    revoke = await async_rc.revoke_signer(
        signer=account.address,
        subaccount_id=async_subaccount.id,
        subaccount=async_subaccount.name,
        submit=False,
    )
    assert isinstance(revoke, async_rc._models.RevokeLinkedSignerDto)
    assert (
        revoke.signature != ""
        and revoke.data.subaccount_id == async_subaccount.id
        and revoke.data.subaccount == async_subaccount.name
        and revoke.data.signer == account.address
    )


@pytest.mark.asyncio
async def test_prepare_refresh_linked_signer(async_rc_ro, async_subaccount, network):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    refresh = await async_rc_ro.prepare_refresh_linked_signer(
        sender=async_rc_ro.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    assert isinstance(refresh, async_rc_ro._models.RefreshLinkedSignerDto)
    assert (
        refresh.data.sender == async_rc_ro.chain.address
        and refresh.data.signer == account.address
        and refresh.data.subaccount_id == sid_any
        and refresh.signature == ""
    )


@pytest.mark.asyncio
async def test_prepare_and_sign_refresh_linked_signer(
    async_rc, async_subaccount, network
):
    sname = async_subaccount.name
    sid_any = async_subaccount.id
    account = Account.create()
    refresh = await async_rc.prepare_refresh_linked_signer(
        sender=async_rc.chain.address,
        signer=account.address,
        subaccount=sname,
        subaccount_id=sid_any,
    )
    refresh = await async_rc.sign_refresh_linked_signer(refresh)
    assert (
        isinstance(refresh, async_rc._models.RefreshLinkedSignerDto)
        and refresh.signature != ""
    )


@pytest.mark.asyncio
async def test_refresh_signer_helper(async_rc, async_subaccount, network):
    account = Account.create()
    refresh = await async_rc.refresh_signer(
        signer=account.address,
        subaccount_id=async_subaccount.id,
        subaccount=async_subaccount.name,
        submit=False,
    )
    assert isinstance(refresh, async_rc._models.RefreshLinkedSignerDto)
    assert (
        refresh.signature != ""
        and refresh.data.subaccount_id == async_subaccount.id
        and refresh.data.subaccount == async_subaccount.name
        and refresh.data.signer == account.address
    )
