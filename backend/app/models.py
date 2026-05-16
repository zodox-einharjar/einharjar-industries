from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Boolean, Float, ForeignKey, Index, Integer, Numeric, Text, TIMESTAMP
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


class Character(Base):
    __tablename__ = "characters"

    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    character_owner_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    character_name: Mapped[str] = mapped_column(Text, nullable=False)
    corporation_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    corporation_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    access_token: Mapped[str] = mapped_column(Text, nullable=False)
    refresh_token: Mapped[str] = mapped_column(Text, nullable=False)
    token_expires: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    scopes: Mapped[list] = mapped_column(ARRAY(Text), nullable=False, default=list)


class ESICache(Base):
    __tablename__ = "esi_cache"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    value: Mapped[str] = mapped_column(Text, nullable=False)


class Location(Base):
    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    eve_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False)
    location_type: Mapped[str] = mapped_column(Text, nullable=False)  # "structure" or "station"
    region_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    system_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Market fees as percentages (e.g. 3.5 = 3.5%)
    # Defaults: NPC station with perfect skills (Broker Relations 5, Accounting 5)
    broker_fee_pct: Mapped[float] = mapped_column(Float, nullable=False, server_default="3.5")
    sales_tax_pct: Mapped[float] = mapped_column(Float, nullable=False, server_default="3.6")
    scc_surcharge_pct: Mapped[float] = mapped_column(Float, nullable=False, server_default="0.0")


class FreightRoute(Base):
    __tablename__ = "freight_routes"

    id: Mapped[int] = mapped_column(primary_key=True)
    from_id: Mapped[int] = mapped_column(ForeignKey("locations.id", ondelete="CASCADE"), nullable=False)
    to_id: Mapped[int] = mapped_column(ForeignKey("locations.id", ondelete="CASCADE"), nullable=False)
    isk_per_m3: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    # Stored as decimal fraction, e.g. 0.01 = 1%
    value_pct: Mapped[Decimal] = mapped_column(Numeric(10, 6), nullable=False)

    from_location: Mapped["Location"] = relationship(foreign_keys=[from_id])
    to_location: Mapped["Location"] = relationship(foreign_keys=[to_id])


class Fit(Base):
    __tablename__ = "fits"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    ship_type_id: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_eft: Mapped[str] = mapped_column(Text, nullable=False)

    items: Mapped[list["FitItem"]] = relationship(back_populates="fit", cascade="all, delete-orphan")
    doctrine_fits: Mapped[list["DoctrineFit"]] = relationship(back_populates="fit")


class FitItem(Base):
    __tablename__ = "fit_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    fit_id: Mapped[int] = mapped_column(ForeignKey("fits.id", ondelete="CASCADE"), nullable=False)
    type_id: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)

    fit: Mapped["Fit"] = relationship(back_populates="items")


class Doctrine(Base):
    __tablename__ = "doctrines"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    location_id: Mapped[int | None] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True
    )

    location: Mapped["Location | None"] = relationship(foreign_keys=[location_id])
    doctrine_fits: Mapped[list["DoctrineFit"]] = relationship(
        back_populates="doctrine", cascade="all, delete-orphan"
    )


class DoctrineFit(Base):
    __tablename__ = "doctrine_fits"

    id: Mapped[int] = mapped_column(primary_key=True)
    doctrine_id: Mapped[int] = mapped_column(ForeignKey("doctrines.id", ondelete="CASCADE"), nullable=False)
    fit_id: Mapped[int] = mapped_column(ForeignKey("fits.id", ondelete="CASCADE"), nullable=False)
    target_qty: Mapped[int] = mapped_column(Integer, nullable=False)

    doctrine: Mapped["Doctrine"] = relationship(back_populates="doctrine_fits")
    fit: Mapped["Fit"] = relationship(back_populates="doctrine_fits")


class InventoryLot(Base):
    __tablename__ = "inventory_lots"

    id: Mapped[int] = mapped_column(primary_key=True)
    type_id: Mapped[int] = mapped_column(Integer, index=True, nullable=False)
    item_name: Mapped[str] = mapped_column(Text, nullable=False)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id", ondelete="SET NULL"), nullable=True)
    qty_original: Mapped[int] = mapped_column(Integer, nullable=False)
    qty_remaining: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    purchased_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False, default="manual")
    esi_transaction_id: Mapped[int | None] = mapped_column(BigInteger, unique=True, nullable=True)
    seller: Mapped[str | None] = mapped_column(Text, nullable=True)
    character_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    wallet_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    parent_lot_id: Mapped[int | None] = mapped_column(ForeignKey("inventory_lots.id"), nullable=True)

    location: Mapped["Location"] = relationship(foreign_keys=[location_id])
    sales: Mapped[list["InventorySale"]] = relationship(back_populates="lot", cascade="all, delete-orphan")


class InventorySale(Base):
    __tablename__ = "inventory_sales"

    id: Mapped[int] = mapped_column(primary_key=True)
    lot_id: Mapped[int] = mapped_column(ForeignKey("inventory_lots.id", ondelete="CASCADE"), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_sell_price: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    sold_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False, default="manual")
    esi_transaction_id: Mapped[int | None] = mapped_column(BigInteger, unique=True, nullable=True)
    buyer: Mapped[str | None] = mapped_column(Text, nullable=True)
    character_name: Mapped[str | None] = mapped_column(Text, nullable=True)

    lot: Mapped["InventoryLot"] = relationship(back_populates="sales")


class InventoryTransfer(Base):
    __tablename__ = "inventory_transfers"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_lot_id: Mapped[int] = mapped_column(ForeignKey("inventory_lots.id", ondelete="CASCADE"), nullable=False)
    dest_lot_id: Mapped[int] = mapped_column(ForeignKey("inventory_lots.id", ondelete="CASCADE"), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    freight_cost_total: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    transferred_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)


class IndustryProject(Base):
    __tablename__ = "industry_projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="planning")
    ravworks_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    invention_cost: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False, server_default="0")
    blueprint_cost: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False, server_default="0")
    extra_cost: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False, server_default="0")
    target_margin_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    output_location_id: Mapped[int | None] = mapped_column(
        ForeignKey("locations.id", ondelete="SET NULL"), nullable=True
    )
    character_id: Mapped[int] = mapped_column(
        ForeignKey("characters.id", ondelete="CASCADE"), nullable=False
    )
    frozen_material_cost: Mapped[Decimal | None] = mapped_column(Numeric(20, 2), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)

    output_location: Mapped["Location | None"] = relationship(foreign_keys=[output_location_id])
    materials: Mapped[list["ProjectMaterial"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    outputs: Mapped[list["ProjectOutput"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    jobs: Mapped[list["ProjectJob"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class ProjectMaterial(Base):
    __tablename__ = "project_materials"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("industry_projects.id", ondelete="CASCADE"), nullable=False
    )
    type_id: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity_needed: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity_reserved: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    project: Mapped["IndustryProject"] = relationship(back_populates="materials")
    reservations: Mapped[list["LotReservation"]] = relationship(back_populates="material", cascade="all, delete-orphan")


class ProjectOutput(Base):
    __tablename__ = "project_outputs"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("industry_projects.id", ondelete="CASCADE"), nullable=False
    )
    type_id: Mapped[int] = mapped_column(Integer, nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    is_byproduct: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")

    project: Mapped["IndustryProject"] = relationship(back_populates="outputs")


class ProjectJob(Base):
    __tablename__ = "project_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("industry_projects.id", ondelete="CASCADE"), nullable=False
    )
    category: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    runs: Mapped[int] = mapped_column(Integer, nullable=False)
    days: Mapped[float] = mapped_column(Float, nullable=False)
    job_cost: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    is_done: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")

    project: Mapped["IndustryProject"] = relationship(back_populates="jobs")


class LotReservation(Base):
    __tablename__ = "lot_reservations"

    id: Mapped[int] = mapped_column(primary_key=True)
    lot_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_lots.id", ondelete="CASCADE"), nullable=False
    )
    project_id: Mapped[int] = mapped_column(
        ForeignKey("industry_projects.id", ondelete="CASCADE"), nullable=False
    )
    material_id: Mapped[int] = mapped_column(
        ForeignKey("project_materials.id", ondelete="CASCADE"), nullable=False
    )
    qty_reserved: Mapped[int] = mapped_column(Integer, nullable=False)

    lot: Mapped["InventoryLot"] = relationship(foreign_keys=[lot_id])
    material: Mapped["ProjectMaterial"] = relationship(back_populates="reservations")


class MarketOrder(Base):
    __tablename__ = "market_orders"
    __table_args__ = (
        Index("ix_market_orders_loc_type", "location_id", "type_id"),
    )

    order_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("locations.id", ondelete="CASCADE"), nullable=False)
    type_id: Mapped[int] = mapped_column(Integer, nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    volume_remain: Mapped[int] = mapped_column(Integer, nullable=False)
    is_buy: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    fetched_at: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)


class MarketListing(Base):
    __tablename__ = "market_listings"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"), nullable=False)
    type_id: Mapped[int] = mapped_column(Integer, nullable=False)
    eve_location_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    qty_total: Mapped[int] = mapped_column(Integer, nullable=False)
    qty_remaining: Mapped[int] = mapped_column(Integer, nullable=False)
    list_price: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    issued: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    expires: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    # active | expired | cancelled
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    last_synced: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)

    character: Mapped["Character"] = relationship(foreign_keys=[character_id])


class Contract(Base):
    __tablename__ = "contracts"

    id: Mapped[int] = mapped_column(primary_key=True)
    contract_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True, nullable=False)
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)  # "char" | "corp"

    issuer_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    issuer_corporation_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    assignee_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    acceptor_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    type: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    for_corporation: Mapped[bool] = mapped_column(Boolean, nullable=False)
    availability: Mapped[str] = mapped_column(Text, nullable=False)

    date_issued: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    date_expired: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
    date_accepted: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    date_completed: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True), nullable=True)
    days_to_complete: Mapped[int | None] = mapped_column(Integer, nullable=True)

    price: Mapped[Decimal | None] = mapped_column(Numeric(20, 2), nullable=True)
    reward: Mapped[Decimal | None] = mapped_column(Numeric(20, 2), nullable=True)
    collateral: Mapped[Decimal | None] = mapped_column(Numeric(20, 2), nullable=True)
    buyout: Mapped[Decimal | None] = mapped_column(Numeric(20, 2), nullable=True)
    volume: Mapped[float | None] = mapped_column(Float, nullable=True)

    start_location_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    end_location_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    last_synced: Mapped[datetime] = mapped_column(TIMESTAMP(timezone=True), nullable=False)
